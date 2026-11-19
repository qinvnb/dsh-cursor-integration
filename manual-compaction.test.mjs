import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from './src/manual-compaction.js';

function fixture(compactNow) {
  const events = [];
  const session = {
    get seq() { return events.length; },
    eventAt: index => events[index],
    append(type, data) { events.push({ type, data }); },
  };
  let handler, dispose;
  apply({
    compaction: { compactNow },
    logger: { warn() {} },
    effect(mount) { const effects = mount(); dispose = effects.next().value; effects.next(); },
    commands: { register: definition => { handler = definition.handler; } },
  });
  const agent = { session };
  const submit = (rawInput = '', signal = new AbortController().signal) => handler({ agent, commandId: 'current', rawInput, signal });
  return { submit, session, events, dispose };
}

test('acknowledges before the native summary completes and outlives the client request', async () => {
  const request = new AbortController();
  const hold = Promise.withResolvers();
  let operationSignal, runs = 0;
  const { submit, events, dispose } = fixture(async ({ session }, signal, sourceCommandId) => {
    runs++;
    operationSignal = signal;
    session.append('compaction/start', { sourceCommandId });
    await hold.promise;
    signal.throwIfAborted();
    session.append('compaction/summary', { sourceCommandId });
    session.append('compaction/end', { sourceCommandId });
    return { summarySeq: 1 };
  });
  assert.match(submit('', request.signal).text, /已开始后台压缩/);
  assert.equal(events.length, 1);
  request.abort();
  assert.equal(operationSignal.aborted, false);
  assert.equal(submit().kind, 'error');
  assert.equal(runs, 1);
  hold.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).type, 'compaction/end');
  assert.equal(submit('cancel').kind, 'error');
  await dispose();
});

test('cancellation and plugin disposal stop pending background work', async () => {
  let cancelled = 0;
  const { submit, dispose } = fixture(async ({ session }, signal, sourceCommandId) => {
    session.append('compaction/start', { sourceCommandId });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    cancelled++;
    session.append('compaction/end', { sourceCommandId, error: 'Request cancelled' });
    signal.throwIfAborted();
  });
  assert.equal(submit().kind, 'success');
  assert.equal(submit('cancel').kind, 'success');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(submit().kind, 'success');
  await dispose();
  assert.equal(cancelled, 2);
});

test('busy, no compactable history, and pre-aborted requests never report a start', async () => {
  let calls = 0;
  const { submit, dispose } = fixture(async () => {
    if (++calls === 1) throw Object.assign(new Error(), { name: 'ManualCompactionError', code: 'busy' });
    return null;
  });
  assert.equal((await submit()).kind, 'error');
  assert.equal((await submit()).text, '当前没有可压缩的历史。');
  assert.throws(() => submit('', AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(calls, 2);
  await dispose();
});

test('does not cancel a summary whose native end event is already being flushed', async () => {
  const hold = Promise.withResolvers();
  let aborted;
  const { submit, dispose } = fixture(async ({ session }, signal, sourceCommandId) => {
    session.append('compaction/start', { sourceCommandId });
    session.append('compaction/end', { sourceCommandId });
    await hold.promise;
    aborted = signal.aborted;
    return { summarySeq: 1 };
  });
  assert.equal(submit().kind, 'success');
  assert.match(submit('cancel').text, /正在保存/);
  hold.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, false);
  await dispose();
});
