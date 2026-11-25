import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { appendFile, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCursorHost, sdkCreateDiagnostic, summarizeUnrecognizedError } from './network.js';
import { ProviderError } from './provider.js';

const scope = new AsyncLocalStorage();
const methods = new Map([
  ['/agent.v1.AgentService/Run', 'run'],
  ['/agent.v1.AgentService/RunSSE', 'run_sse'],
  ['/agent.v1.AgentService/RunPoll', 'run_poll'],
  ['/aiserver.v1.BidiService/BidiAppend', 'bidi_append'],
]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const requestId = value => typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : undefined;
const runId = value => typeof value === 'string' && value.startsWith('run-') ? requestId(value.slice(4)) : undefined;
const statusCode = value => (typeof value === 'number' || typeof value === 'string' && /^\d{3}$/.test(value)) &&
  Number.isInteger(Number(value)) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : undefined;
const grpcCode = value => typeof value === 'string' && /^(?:[0-9]|1[0-6])$/.test(value) ? Number(value) : undefined;
const providerCodes = new Set([
  'ABORTED', 'TIMEOUT', 'CURSOR_RATE_LIMITED', 'CURSOR_AUTH_FAILED', 'CURSOR_SERVICE_FAILED',
  'CURSOR_CONTEXT_TOO_LONG', 'CURSOR_RESUME_FAILED', 'CURSOR_RETRY_EXHAUSTED', 'CURSOR_SDK_ERROR',
  'CURSOR_NETWORK_TIMEOUT', 'CURSOR_CONNECTION_RESET', 'CURSOR_CONNECTION_UNAVAILABLE', 'CURSOR_CONNECTION_STALLED',
  'INVALID_ARGUMENTS', 'NATIVE_TOOL_BLOCKED', 'SDK_RUN_FAILED', 'SYSTEM_PROMPT_REJECTED',
]);
const sessionTag = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function currentRequestDiagnostics() { return scope.getStore(); }

export function createRequestDiagnostics({ directory, maxBytes = 1024 * 1024, onWriteFailure = () => {} }) {
  const file = join(directory, 'request-diagnostics.jsonl');
  const owner = {};
  const pending = [];
  let active = true, timer, writing, size, dropped = 0;

  function schedule() {
    if (!active || timer || writing || !pending.length) return;
    timer = setTimeout(flush, 250);
    timer.unref?.();
  }
  function enqueue(record) {
    if (!active) return;
    if (pending.length === 256) { dropped++; return; }
    pending.push(JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
    schedule();
  }
  async function persist(batch) {
    if (size === undefined) {
      await mkdir(directory, { recursive: true });
      size = await stat(file).then(info => info.size, error => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
    }
    const bytes = Buffer.byteLength(batch);
    if (size && size + bytes > maxBytes) {
      await copyFile(file, file + '.1');
      await writeFile(file, batch, { mode: 0o600 });
      size = bytes;
    } else {
      await appendFile(file, batch, { mode: 0o600 });
      size += bytes;
    }
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (writing || !pending.length) return writing;
    if (dropped) pending.push(JSON.stringify({ time: new Date().toISOString(), event: 'dropped', count: dropped }) + '\n');
    dropped = 0;
    writing = persist(pending.splice(0).join('')).catch(() => {
      active = false;
      pending.length = 0;
      try { onWriteFailure(); } catch {}
    }).finally(() => {
      writing = undefined;
      schedule();
    });
    return writing;
  }

  const exchanges = new WeakMap();
  function startExchange(target, host, path, protocol, headers) {
    const turn = scope.getStore();
    if (turn?.owner !== owner || !turn.active || typeof host !== 'string' || !isCursorHost(host.split(':')[0])) return;
    const operation = methods.get(path);
    if (!operation) return;
    const properties = {
      exchange: ++turn.exchanges, protocol, operation,
      requestId: requestId(headers('x-request-id')),
      originalRequestId: requestId(headers('x-original-request-id')),
    };
    const started = performance.now();
    const record = (event, extra) => {
      turn.record(event, { ...properties, ms: Math.round(performance.now() - started), ...extra });
      if (event === 'response_headers') {
        try { turn.onResponseHeaders?.(extra?.http, extra?.grpc, properties); } catch {}
      }
    };
    exchanges.set(target, record);
    record('request_start');
    if (properties.requestId && properties.originalRequestId && properties.requestId !== properties.originalRequestId
        && !turn.retries.has(properties.requestId)) {
      turn.retries.add(properties.requestId);
      record('sdk_retry');
      try { turn.onRetry?.(turn.retries.size, properties); } catch {}
    }
    return record;
  }

  const subscribers = Object.entries({
    'http2.client.stream.created': ({ stream, headers }) => {
      const record = startExchange(stream, headers[':authority'], headers[':path'], 'h2', name => headers[name]);
      if (!record) return;
      stream.once('trailers', headers => {
        const code = grpcCode(headers['grpc-status']);
        if (code !== undefined) record('response_trailers', { grpc: code });
      });
    },
    'http2.client.stream.finish': ({ stream, headers }) => {
      exchanges.get(stream)?.('response_headers', { http: statusCode(headers[':status']), grpc: grpcCode(headers['grpc-status']) });
    },
    'http2.client.stream.error': ({ stream, error }) => exchanges.get(stream)?.('network_error', { facts: sdkCreateDiagnostic(error) }),
    'http2.client.stream.close': ({ stream }) => {
      exchanges.get(stream)?.('request_end', { resetCode: stream.rstCode });
      exchanges.delete(stream);
    },
    'http.client.request.created': ({ request }) => {
      if (request.protocol !== 'https:') return;
      const record = startExchange(request, request.getHeader('host'), request.path, 'http1', name => request.getHeader(name));
      if (!record) return;
      let responded = false;
      request.once('response', response => {
        responded = true;
        record('response_headers', { http: statusCode(response.statusCode), grpc: grpcCode(response.headers['grpc-status']) });
        response.once?.('error', error => record('network_error', { facts: sdkCreateDiagnostic(error) }));
        response.once('close', () => {
          const code = grpcCode(response.trailers['grpc-status']);
          if (code !== undefined) record('response_trailers', { grpc: code });
          record('request_end', { responseComplete: response.complete, ...(response.aborted ? { responseAborted: true } : {}) });
        });
      });
      request.once?.('close', () => {
        if (!responded) record('request_end', { responded: false, ...(request.destroyed ? { destroyed: true } : {}) });
      });
    },
    'http.client.request.error': ({ request, error }) => exchanges.get(request)?.('network_error', { facts: sdkCreateDiagnostic(error) }),
  }).map(([name, observe]) => {
    const topic = channel(name);
    const listener = message => { try { observe(message); } catch { /* Observations must not affect networking. */ } };
    topic.subscribe(listener);
    return [topic, listener];
  });

  return {
    async run(sessionId, route, action, agentHttpProtocol, hooks) {
      if (!active || typeof sessionId !== 'string' || !sessionId) return action();
      const id = randomUUID();
      const session = sessionTag(sessionId);
      const turn = {
        owner, active: true, exchanges: 0, retries: new Set(), onRetry: hooks?.onRetry, onResponseHeaders: hooks?.onResponseHeaders,
        record(event, fields) {
          if (turn.active) enqueue({ turn: id, session, route, event, ...fields });
        },
        proxyFailure(stage, error, status) {
          turn.record('proxy_error', { stage, http: statusCode(status), facts: error && sdkCreateDiagnostic(error) });
        },
        result(status, phase, run, result, error, cause) {
          const facts = result?.error !== undefined ? sdkCreateDiagnostic(result.error)
            : result && result.status !== 'finished' && status === 'error' ? ['missing_result_error']
            : error instanceof ProviderError && error.facts?.length ? [...error.facts]
            : cause ? sdkCreateDiagnostic(cause) : undefined;
          const unrecognizedSource = result?.error ?? (cause?.cause ?? cause);
          const unrecognizedSummary = unrecognizedSource !== undefined && facts?.length === 1 && facts[0] === 'no recognized error code'
            ? summarizeUnrecognizedError(unrecognizedSource)
            : undefined;
          turn.record('turn_result', {
            status, phase, sdkRun: runId(run?.id), sdkRequestId: requestId(run?.requestId),
            resultRequestId: requestId(result?.requestId),
            code: error instanceof ProviderError && providerCodes.has(error.code) ? error.code : undefined,
            facts,
            ...(unrecognizedSummary ? { unrecognizedSummary } : {}),
          });
        },
      };
      turn.record('turn_start', { agentHttpProtocol });
      try { return await scope.run(turn, action, turn); }
      finally { turn.active = false; }
    },
    async close() {
      active = false;
      for (const [topic, listener] of subscribers) topic.unsubscribe(listener);
      await writing;
      await flush();
    },
  };
}
