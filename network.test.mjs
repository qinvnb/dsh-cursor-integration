import assert from 'node:assert/strict';
import test from 'node:test';
import { createCursorProxy } from './src/proxy.js';
import { describeNetworkFailure, describeRunFailure, retryBootstrapRequest, sdkCreateDiagnostic, summarizeUnrecognizedError } from './src/network.js';

function failure(code) {
  return new TypeError('fetch failed with confidential details', { cause: Object.assign(new Error('private upstream details'), { code }) });
}

async function withFetch(handler, task) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  const proxy = createCursorProxy('http://127.0.0.1:7890');
  try { await task(proxy); }
  finally { await proxy.close(); globalThis.fetch = original; }
}

const exchange = () => fetch('https://api2.cursor.sh/auth/exchange_user_api_key', { method: 'POST', body: '{}' });

test('credential exchange retries transient failures with the dedicated dispatcher', async () => {
  let count = 0;
  await withFetch(async (_input, options) => {
    assert.ok(options.dispatcher);
    if (++count < 3) throw failure(count === 1 ? 'ECONNRESET' : 'UND_ERR_CONNECT_TIMEOUT');
    return new Response('{}');
  }, async proxy => {
    assert.equal((await proxy.run(exchange)).status, 200);
  });
  assert.equal(count, 3);
});

test('model discovery stops after three attempts and exposes only a static error', async () => {
  let count = 0;
  await withFetch(async () => { count++; throw failure('UND_ERR_CONNECT_TIMEOUT'); }, async proxy => {
    await assert.rejects(proxy.run(() => fetch('https://api.cursor.com/v1/models')), error => {
      assert.equal(error.code, 'CURSOR_NETWORK_TIMEOUT');
      assert.match(error.message, /Cursor model discovery/);
      assert.doesNotMatch(error.message, /confidential|private/);
      return true;
    });
  });
  assert.equal(count, 3);
});

test('HTTP authentication and quota failures are returned without replay', async () => {
  for (const status of [401, 403, 429]) {
    let count = 0;
    await withFetch(async () => { count++; return new Response('{}', { status }); }, async proxy => {
      assert.equal((await proxy.run(exchange)).status, status);
    });
    assert.equal(count, 1);
  }
});

test('model inference requests are never retried by the bootstrap wrapper', async () => {
  let count = 0;
  const error = failure('ECONNRESET');
  await withFetch(async () => { count++; throw error; }, async proxy => {
    await assert.rejects(proxy.run(() => fetch('https://api2.cursor.sh/aiserver.v1.AgentService/Run', { method: 'POST', body: '{}' })), thrown => thrown === error);
  });
  assert.equal(count, 1);
});

test('requests outside Cursor scope and unrelated domains retain their original behavior', async () => {
  let count = 0;
  await withFetch(async (_input, options) => {
    count++;
    assert.equal(options?.dispatcher, undefined);
    throw failure('ECONNRESET');
  }, async proxy => {
    await assert.rejects(exchange());
    await assert.rejects(proxy.run(() => fetch('https://example.com/v1/models')));
  });
  assert.equal(count, 2);
});

test('streaming request bodies are not replayed', async () => {
  let count = 0;
  await withFetch(async () => { count++; throw failure('ECONNRESET'); }, async proxy => {
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    await assert.rejects(proxy.run(() => fetch('https://api2.cursor.sh/auth/exchange_user_api_key', { method: 'POST', body, duplex: 'half' })));
  });
  assert.equal(count, 1);
});

test('caller cancellation interrupts the retry delay', async () => {
  const controller = new AbortController();
  let count = 0;
  await withFetch(async () => {
    count++;
    queueMicrotask(() => controller.abort());
    throw failure('ECONNRESET');
  }, async proxy => {
    await assert.rejects(proxy.run(() => fetch('https://api.cursor.com/v1/models', { signal: controller.signal })), { name: 'AbortError' });
  });
  assert.equal(count, 1);
});

test('plugin disposal cancels pending bootstrap retries', async () => {
  let count = 0, proxy;
  await withFetch(async () => {
    count++;
    queueMicrotask(() => { void proxy.close(); });
    throw failure('ECONNRESET');
  }, async current => {
    proxy = current;
    await assert.rejects(proxy.run(exchange), { name: 'AbortError' });
  });
  assert.equal(count, 1);
});

test('certificate errors and other failures are not treated as transient connections', async () => {
  let count = 0;
  const error = failure('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  await assert.rejects(retryBootstrapRequest(async () => { count++; throw error; }, 'Cursor credential exchange'), thrown => thrown === error);
  assert.equal(count, 1);
  assert.equal(describeNetworkFailure(error, 'Cursor request'), undefined);
});

test('nested network causes and SDK stream stalls map to static public categories', () => {
  assert.equal(describeNetworkFailure(failure('ECONNRESET'), 'Cursor request').code, 'CURSOR_CONNECTION_RESET');
  assert.equal(describeNetworkFailure(failure('ECONNREFUSED'), 'Cursor request').code, 'CURSOR_CONNECTION_UNAVAILABLE');
  assert.equal(describeNetworkFailure({ code: 'connection_stalled' }, 'Cursor stream').code, 'CURSOR_CONNECTION_STALLED');
});

test('sdkCreateDiagnostic and describeRunFailure classify run.wait errors without leaking raw messages', () => {
  const bidiTimeout = { message: '[deadline_exceeded] bidi_append_deadline_exceeded: append seqno=2 (2048 bytes) exceeded 60000ms deadline' };
  assert.deepEqual(sdkCreateDiagnostic(bidiTimeout), ['deadline_exceeded', 'bidi_append_deadline_exceeded']);
  const timeoutErr = describeRunFailure(bidiTimeout, 'error');
  assert.equal(timeoutErr.code, 'CURSOR_NETWORK_TIMEOUT');
  assert.deepEqual(timeoutErr.facts, ['deadline_exceeded', 'bidi_append_deadline_exceeded']);
  assert.match(timeoutErr.message, /deadline_exceeded, bidi_append_deadline_exceeded/);

  for (const sample of [
    { message: 'Connection failed with private info' },
    { message: '[unknown] unsupported content type null' },
    { message: 'http/2 stream closed with error code INTERNAL_ERROR' },
  ]) {
    const err = describeRunFailure(sample, 'error');
    assert.equal(err.code, 'CURSOR_CONNECTION_RESET');
    assert.doesNotMatch(err.message, /private info/);
  }

  for (const sample of [
    { message: '[unavailable] upstream overloaded' },
    { message: '[unknown] HTTP 464' },
    { message: 'The server failed 3 times' },
  ]) {
    assert.equal(describeRunFailure(sample, 'error').code, 'CURSOR_SERVICE_FAILED');
  }

  assert.equal(describeRunFailure({ message: '[resource_exhausted] Rate limit exceeded' }, 'error').code, 'CURSOR_RATE_LIMITED');
  assert.equal(describeRunFailure({ message: 'CONVERSATION_TOO_LONG' }, 'error').code, 'CURSOR_CONTEXT_TOO_LONG');
  assert.equal(describeRunFailure({ message: 'Sign in required' }, 'error').code, 'CURSOR_AUTH_FAILED');
  assert.equal(describeRunFailure({ message: 'Invalid system prompt: permission denied' }, 'error').code, 'SYSTEM_PROMPT_REJECTED');
  assert.equal(describeRunFailure({ message: 'cancelled' }, 'cancelled').code, 'ABORTED');

  const secret = { message: 'secret token sk-live-12345 failed' };
  assert.deepEqual(sdkCreateDiagnostic(secret), ['no recognized error code']);
  const unknown = describeRunFailure(secret, 'error');
  assert.equal(unknown.code, 'SDK_RUN_FAILED');
  assert.equal(unknown.facts, undefined);
  assert.doesNotMatch(unknown.message, /secret|sk-live-12345/);

  const noProgress = describeRunFailure({ message: 'Agent turn stopped after repeated resume attempts made no progress' }, 'error');
  assert.equal(noProgress.code, 'CURSOR_CONNECTION_RESET');
  assert.deepEqual(noProgress.facts, ['resume_no_progress']);
});

test('summarizeUnrecognizedError redacts sensitive values and caps summary length', () => {
  const sample = {
    message: 'Check https://api2.cursor.sh/v1 api2.cursor.sh user@example.com Bearer tok-secret-999 api_key=mysecret123 sk-live-1234567890 123e4567-e89b-12d3-a456-426614174000 C:\\Users\\alice\\key.txt /home/alice/secret/file abcd1234efgh5678ijkl9012 "very long sensitive quoted payload"',
  };
  const redacted = summarizeUnrecognizedError(sample);
  assert.ok(redacted);
  assert.doesNotMatch(redacted, /cursor\.sh|user@example\.com|tok-secret-999|mysecret123|sk-live-1234567890|123e4567|alice|abcd1234efgh5678ijkl9012|sensitive quoted/);
  assert.match(redacted, /\[url\].*\[host\].*\[email\].*Bearer \[redacted\].*\[token\]/);

  const longReadable = summarizeUnrecognizedError('Plan limit reached on your team workspace. ' + 'Please review billing details. '.repeat(6));
  assert.equal(longReadable.length, 160);
  assert.ok(longReadable.endsWith('...'));
});
