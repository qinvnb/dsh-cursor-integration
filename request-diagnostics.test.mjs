import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
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
  });
  await receiving;
  channel('http.client.request.error').publish({ request, error: { code: 'ETIMEDOUT', message: 'private error' } });
  finish();
  await task;
  await diagnostics.close();
  const rows = (await readFile(join(directory, file), 'utf8')).trim().split('\n').map(JSON.parse);
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
