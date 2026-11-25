import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair } from 'node:stream';
import { test } from 'node:test';
import { createRequestDiagnostics } from './src/request-diagnostics.js';
import { CursorTransport } from './src/transport.js';

const initial = 'c491ebed-0c7c-4bcd-9ac6-abcb18d1c9a1';
const retry = 'd5347cd8-082e-4980-8ba2-a2ae2b44aab6';
const file = 'request-diagnostics.jsonl';
const endpoint = '/agent.v1.AgentService/Run';

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'cursor-diagnostics-test-'));
  const diagnostics = createRequestDiagnostics({ directory, ...options });
  t.after(async () => {
    await diagnostics.close();
    for (const entry of await readdir(directory)) await unlink(join(directory, entry));
    await rmdir(directory);
  });
  return { directory, diagnostics };
}

async function exchange(session, path, attempt, original) {
  const stream = session.request({
    ':path': path, ':method': 'POST', 'x-request-id': attempt, 'x-original-request-id': original,
    authorization: 'credential-never-logged',
  });
  stream.resume();
  await new Promise((resolve, reject) => {
    stream.on('close', resolve);
    stream.on('error', reject);
    stream.end('private request body');
  });
}

test('observes real HTTP/2 retries and only saves allowlisted fields', async t => {
  const { directory, diagnostics } = await fixture(t);
  const server = http2.createServer();
  const [client, peer] = duplexPair();
  server.emit('connection', peer);
  const h2 = http2.connect('https://api2.cursor.sh', { createConnection: () => client });
  t.after(() => { h2.destroy(); server.close(); });
  server.on('stream', (stream, headers) => {
    const limited = headers['x-request-id'] === initial;
    stream.respond({ ':status': limited ? 429 : 200, 'set-cookie': 'private cookie' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': limited ? '8' : '0', 'grpc-message': 'private body' }));
    stream.end('private response');
  });
  await exchange(h2, endpoint, initial, initial);
  await diagnostics.run('private session ID', 'proxy', async turn => {
    await exchange(h2, endpoint, initial, initial);
    await new Promise(resolve => setImmediate(resolve));
    turn.proxyFailure('connect', Object.assign(new Error('private upstream details'), { code: 'ECONNRESET' }));
    await exchange(h2, endpoint, retry, initial);
    await exchange(h2, endpoint, retry, initial);
    await exchange(h2, '/irrelevant', retry, initial);
    turn.result('finished', 'wait', { id: 'run-' + initial, requestId: initial }, { requestId: retry });
  });
  await diagnostics.close();
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /private|credential|authorization|cursor\.sh/);
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.equal(new Set(rows.map(row => row.turn)).size, 1);
  assert.equal(rows.filter(row => row.event === 'request_start').length, 3);
  const [retried] = rows.filter(row => row.event === 'sdk_retry');
  assert.equal(rows.filter(row => row.event === 'sdk_retry').length, 1);
  assert.equal(retried.requestId, retry);
  assert.equal(retried.originalRequestId, initial);
  assert.equal(retried.protocol, 'h2');
  assert.ok(rows.some(row => row.event === 'response_headers' && row.requestId === initial && row.http === 429));
  assert.ok(rows.some(row => row.event === 'response_trailers' && row.grpc === 8));
  assert.ok(rows.some(row => row.event === 'proxy_error' && row.facts.includes('ECONNRESET')));
  assert.equal(rows.at(-1).resultRequestId, retry);
});

test('correlates HTTP/1 errors with the originating turn even outside its async scope', async t => {
  const { directory, diagnostics } = await fixture(t);
  const request = { protocol: 'https:', path: endpoint + 'SSE', getHeader: name => ({ host: 'api2.cursor.sh', 'x-request-id': retry, 'x-original-request-id': initial })[name], once() {} };
  let ready, finish;
  const receiving = new Promise(resolve => { ready = resolve; });
  const finished = new Promise(resolve => { finish = resolve; });
  const task = diagnostics.run('example', 'direct', async () => {
    channel('http.client.request.created').publish({ request });
    ready();
    await finished;
  }, 'http1');
  await receiving;
  channel('http.client.request.error').publish({ request, error: { code: 'ETIMEDOUT', message: 'private error' } });
  finish();
  await task;
  await diagnostics.close();
  const rows = (await readFile(join(directory, file), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].agentHttpProtocol, 'http1');
  assert.equal(rows[1].operation, 'run_sse');
  assert.equal(rows[2].event, 'sdk_retry');
  assert.equal(rows[3].protocol, 'http1');
  assert.deepEqual(rows[3].facts, ['ETIMEDOUT']);
  assert.equal(rows[3].route, 'direct');
});

test('records a failed SDK send while preserving the original failure', async t => {
  const { directory, diagnostics } = await fixture(t);
  const error = Object.assign(new Error('sensitive failure'), { name: 'RateLimitError', status: 429 });
  const transport = new CursorTransport({ requestDiagnostics: diagnostics, loadSDK: async () => ({
    JsonlLocalAgentStore: class {}, Agent: { create: async () => ({
      async send() { throw error; }, async [Symbol.asyncDispose]() {},
    }) },
  }) });
  await assert.rejects(async () => {
    for await (const event of transport.stream({ apiKey: 'secret', sessionId: 'example', prompt: 'confidential', model: { id: 'mock' } })) void event;
  }, caught => caught === error);
  await transport.close();
  await diagnostics.close();
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /secret|sensitive|confidential/);
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).phase, 'send');
  assert.deepEqual(rows.at(-1).facts, ['RateLimitError', 'HTTP 429']);
});

test('rotates diagnostics and a write failure does not fail the action', async t => {
  const { directory, diagnostics } = await fixture(t, { maxBytes: 400 });
  await writeFile(join(directory, file), 'older diagnostics\n'.repeat(40));
  await diagnostics.run('example', 'direct', async () => {});
  await diagnostics.close();
  assert.match(await readFile(join(directory, file + '.1'), 'utf8'), /older diagnostics/);
  assert.match(await readFile(join(directory, file), 'utf8'), /turn_start/);

  let warnings = 0;
  const unavailable = createRequestDiagnostics({ directory: join(directory, file), onWriteFailure: () => { warnings++; } });
  assert.equal(await unavailable.run('example', 'direct', async () => 'ok'), 'ok');
  await unavailable.close();
  assert.equal(warnings, 1);
});

test('observes BidiAppend, mid-stream HTTP/1 response errors, and pre-response request closes', async t => {
  const { directory, diagnostics } = await fixture(t);
  const makeReq = path => Object.assign(new EventEmitter(), {
    protocol: 'https:', path,
    getHeader: name => ({ host: 'api2.cursor.sh', 'x-request-id': initial, 'x-original-request-id': initial })[name],
  });
  await diagnostics.run('example', 'proxy', async () => {
    const bidiReq = makeReq('/aiserver.v1.BidiService/BidiAppend');
    channel('http.client.request.created').publish({ request: bidiReq });
    bidiReq.destroyed = true;
    bidiReq.emit('close');

    const sseReq = makeReq('/agent.v1.AgentService/RunSSE');
    channel('http.client.request.created').publish({ request: sseReq });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, headers: {}, trailers: {}, complete: false, aborted: true,
    });
    sseReq.emit('response', response);
    response.emit('error', { code: 'ECONNRESET', message: 'private response detail' });
    response.emit('close');
  }, 'http1');
  await diagnostics.close();
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /private/);
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.operation === 'bidi_append' && row.event === 'request_end' && row.responded === false && row.destroyed === true));
  assert.ok(rows.some(row => row.operation === 'run_sse' && row.event === 'network_error' && row.facts.includes('ECONNRESET')));
  assert.ok(rows.some(row => row.operation === 'run_sse' && row.event === 'request_end' && row.responseComplete === false && row.responseAborted === true));
});

test('records classified run.wait failures and missing result.error facts without leaking messages', async t => {
  const { directory, diagnostics } = await fixture(t);
  const runResults = [
    { status: 'error', error: { message: '[deadline_exceeded] bidi_append_deadline_exceeded: secret body' } },
    { status: 'error' },
  ];
  const transport = new CursorTransport({
    requestDiagnostics: diagnostics,
    loadSDK: async () => ({
      JsonlLocalAgentStore: class {},
      Agent: {
        create: async () => ({
          async send() {
            const next = runResults.shift();
            return { async *stream() {}, wait: async () => next };
          },
          async [Symbol.asyncDispose]() {},
        }),
      },
    }),
  });
  await assert.rejects(async () => {
    for await (const event of transport.stream({ apiKey: 'secret', sessionId: 'example', prompt: 'confidential', model: { id: 'mock' } })) void event;
  }, { code: 'CURSOR_NETWORK_TIMEOUT' });
  await assert.rejects(async () => {
    for await (const event of transport.stream({ apiKey: 'secret', sessionId: 'example', prompt: 'confidential', model: { id: 'mock' } })) void event;
  }, { code: 'SDK_RUN_FAILED' });
  await transport.close();
  await diagnostics.close();
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /secret|confidential/);
  const results = raw.trim().split('\n').map(JSON.parse).filter(row => row.event === 'turn_result');
  assert.equal(results.length, 2);
  assert.equal(results[0].code, 'CURSOR_NETWORK_TIMEOUT');
  assert.deepEqual(results[0].facts, ['deadline_exceeded', 'bidi_append_deadline_exceeded']);
  assert.equal(results[0].unrecognizedSummary, undefined);
  assert.equal(results[1].code, 'SDK_RUN_FAILED');
  assert.deepEqual(results[1].facts, ['missing_result_error']);
  assert.equal(results[1].unrecognizedSummary, undefined);
});

test('records redacted unrecognizedSummary only for unrecognized run.wait errors without leaking raw text to callers', async t => {
  const { directory, diagnostics } = await fixture(t);
  const transport = new CursorTransport({
    requestDiagnostics: diagnostics,
    loadSDK: async () => ({
      JsonlLocalAgentStore: class {},
      Agent: {
        create: async () => ({
          async send() {
            return {
              async *stream() {},
              wait: async () => ({ status: 'error', error: { message: "We've hit a snag at https://api2.cursor.sh/v1 with Bearer sk-live-1234567890" } }),
            };
          },
          async [Symbol.asyncDispose]() {},
        }),
      },
    }),
  });
  await assert.rejects(async () => {
    for await (const event of transport.stream({ apiKey: 'secret', sessionId: 'example', prompt: 'confidential', model: { id: 'mock' } })) void event;
  }, error => {
    assert.equal(error.code, 'SDK_RUN_FAILED');
    assert.equal(error.message, 'SDK run did not complete');
    return true;
  });
  await transport.close();
  await diagnostics.close();
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /cursor\.sh|sk-live-1234567890|confidential/);
  const turnResult = raw.trim().split('\n').map(JSON.parse).find(row => row.event === 'turn_result');
  assert.equal(turnResult.code, 'SDK_RUN_FAILED');
  assert.deepEqual(turnResult.facts, ['no recognized error code']);
  assert.equal(turnResult.unrecognizedSummary, "We've hit a snag at [url] with Bearer [redacted]");
});

test('notifies deduplicated sdk_retry counts and response_headers to turn hooks and records connect-phase redacted summary', async t => {
  const { directory, diagnostics } = await fixture(t);
  const seenCounts = [];
  const seenHeaders = [];
  const makeReq = id => Object.assign(new EventEmitter(), {
    protocol: 'https:', path: '/agent.v1.AgentService/RunSSE',
    getHeader: name => ({ host: 'api2.cursor.sh', 'x-request-id': id, 'x-original-request-id': initial })[name],
  });
  await diagnostics.run('example', 'proxy', async turn => {
    const req1 = makeReq(initial);
    channel('http.client.request.created').publish({ request: req1 });
    const req2 = makeReq(retry);
    channel('http.client.request.created').publish({ request: req2 });
    channel('http.client.request.created').publish({ request: makeReq(retry) });
    req2.emit('response', Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, trailers: {} }));
    channel('http.client.request.created').publish({ request: makeReq('e5347cd8-082e-4980-8ba2-a2ae2b44aab7') });
    turn.result('error', 'stream', { id: 'run-' + initial, requestId: initial }, undefined,
      Object.assign(new Error('stop'), { name: 'ProviderError', code: 'CURSOR_RETRY_EXHAUSTED', facts: ['retry_budget_exceeded'] }),
      { code: 'retry_budget_exceeded' });
    turn.result('error', 'connect', undefined, undefined, undefined,
      Object.assign(new Error('Connect stalled at https://api2.cursor.sh with token=sk-secret123456'), {
        cause: new Error('Connect stalled at https://api2.cursor.sh with token=sk-secret123456'),
      }));
  }, 'http1', { onRetry: count => seenCounts.push(count), onResponseHeaders: (http, grpc) => seenHeaders.push({ http, grpc }) });
  await diagnostics.close();
  assert.deepEqual(seenCounts, [1, 2]);
  assert.deepEqual(seenHeaders, [{ http: 200, grpc: undefined }]);
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /sk-secret123456|cursor\.sh/);
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.event === 'sdk_retry').length, 2);
  const results = rows.filter(row => row.event === 'turn_result');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].facts, ['retry_budget_exceeded']);
  assert.deepEqual(results[1].facts, ['no recognized error code']);
  assert.equal(results[1].unrecognizedSummary, 'Connect stalled at [url] with [redacted]');
});
