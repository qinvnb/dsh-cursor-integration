import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeBridge, isRuntimeContext, stableHistory } from './src/native.js';
import { defineAdapter } from './src/adapter.js';

const snapshot = kind => ({
  role: 'user',
  source: { kind, form: 'snapshot' },
  content: [{ type: 'text', text: 'Host context' }],
});

test('time snapshots resume exact pending tool results', async () => {
  let call;
  const bridge = new NativeBridge([{ name: 'read_file', parameters: { type: 'object' } }], () => true, event => { call = event; });
  const pending = bridge.customTools.read_file.execute({ path: 'example.txt' });
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }] },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'Read result' }] },
    snapshot('time-context'),
  ];
  bridge.resume(messages, [call.id]);
  const result = await pending;
  assert.equal(result.content[0].text, 'Read result');
  assert.match(result.content[1].text, /time-context/);
  assert.equal(bridge.pending.size, 0);
  bridge.close();
});

test('ordinary user messages and unsourced snapshots cannot impersonate host context', async () => {
  assert.equal(isRuntimeContext({ ...snapshot('time-context'), source: undefined }), false);
  assert.equal(isRuntimeContext(snapshot('skill-catalog')), false);
  let call;
  const bridge = new NativeBridge([{ name: 'read_file', parameters: {} }], () => true, event => { call = event; });
  const pending = bridge.customTools.read_file.execute({});
  const rejected = assert.rejects(pending, { code: 'ABORTED' });
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }] },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'Read result' }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ];
  assert.throws(() => bridge.results(messages), { code: 'TOOL_RESULT_MISMATCH' });
  bridge.close();
  await rejected;
});

test('context snapshots do not rewrite the stable continuation prefix', () => {
  const ordinary = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
  assert.deepEqual(stableHistory([snapshot('runtime-context'), ordinary, snapshot('time-context')]), [ordinary]);
});

async function selectedContinuation(tail) {
  let actual;
  const Adapter = defineAdapter({
    LlmAdapter: class {},
    transport: {
      catalog: async () => [{ id: 'test-model', parameters: [], variants: [] }],
      async *stream(request) {
        actual = request.continuation;
        yield { type: 'text', text: 'OK' };
      },
    },
    profile: () => ({}),
    credential: async () => 'test-credential',
    validate: () => true,
  });
  const assistant = {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call', name: 'read_file', arguments: '{}' }],
    source: { replayState: { response: { protocol: 'cursor-native-v1', continuation: 'old-token' } } },
  };
  const result = { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'Already read' }] };
  for await (const event of new Adapter().stream({ model: 'test-model', messages: [assistant, result, ...tail] })) {
    if (event.type === 'finish') assert.equal(event.reason.kind, 'stop');
  }
  return actual;
}

test('automatic tool continuation retains its token with a time snapshot', async () => {
  assert.equal(await selectedContinuation([snapshot('time-context')]), 'old-token');
});

test('a new user turn rebuilds from recorded history instead of reusing an expired token', async () => {
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] };
  assert.equal(await selectedContinuation([user, snapshot('time-context')]), undefined);
});
