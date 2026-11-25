import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { canRetryTurn, submitSessionRetry } from './src/usage/retry.js';

test('canRetryTurn only enables Retry for idle, open, primary Cursor sessions with a continuable failure', () => {
  const base = {
    cursor: true,
    retryableFailure: 42,
    running: false,
    removed: false,
    openState: 'open',
    pendingSubmissions: 0,
    subagent: null,
    hasQueued: false,
  };
  assert.equal(canRetryTurn(base), true);
  assert.equal(canRetryTurn({ ...base, cursor: false }), false);
  assert.equal(canRetryTurn({ ...base, retryableFailure: null }), false);
  assert.equal(canRetryTurn({ ...base, running: true }), false);
  assert.equal(canRetryTurn({ ...base, removed: true }), false);
  assert.equal(canRetryTurn({ ...base, openState: 'loading' }), false);
  assert.equal(canRetryTurn({ ...base, pendingSubmissions: 1 }), false);
  assert.equal(canRetryTurn({ ...base, subagent: { id: 'child' } }), false);
  assert.equal(canRetryTurn({ ...base, hasQueued: true }), false);
});

test('submitSessionRetry invokes session.prompt([], "queue") and handles unavailable/rejected cases', async () => {
  const calls = [];
  const ctx = {
    get(key) {
      if (key !== 'sessions') return undefined;
      return {
        binding(id) {
          if (id === 'ok') {
            return { session: { prompt: async (content, mode) => { calls.push({ content, mode }); return { ok: true }; } } };
          }
          if (id === 'reject') {
            return { session: { prompt: async () => ({ ok: false }) } };
          }
          if (id === 'throw') {
            return { session: { prompt: async () => { throw new Error('boom'); } } };
          }
          return undefined;
        },
      };
    },
  };

  assert.deepEqual(await submitSessionRetry(ctx, 'ok'), { ok: true, message: '' });
  assert.deepEqual(calls, [{ content: [], mode: 'queue' }]);
  assert.equal((await submitSessionRetry(ctx, 'missing')).ok, false);
  assert.equal((await submitSessionRetry(ctx, 'reject')).ok, false);
  assert.equal((await submitSessionRetry(ctx, 'throw')).ok, false);
});

test('built client Dock renders Retry button when continuable and submits empty queue retry on click', async t => {
  const code = await readFile(new URL('./src/client.js', import.meta.url), 'utf8');
  let loaded;
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) });
  const fakeReact = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useRef: init => ({ current: init }),
    useEffect: () => {},
    useSyncExternalStore: (_sub, snap) => snap(),
  };
  const fakePrimitives = {
    Menu: () => null,
    IconChevronDownOutlineRegular: () => null,
  };
  const timers = new Set();
  const sandbox = {
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); id.unref?.(); timers.add(id); return id; },
    clearInterval: id => { timers.delete(id); clearInterval(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); id.unref?.(); timers.add(id); return id; },
    clearTimeout: id => { timers.delete(id); clearTimeout(id); },
    window: {
      __ModuleLoader__: {
        load(entry) { loaded = entry; },
      },
    },
  };
  t.after(() => { for (const id of timers) { clearInterval(id); clearTimeout(id); } });
  vm.runInNewContext(code, sandbox);
  const exportsObj = loaded.factory(id => (id === 'react' ? fakeReact : fakePrimitives));

  let dockComponent;
  const promptCalls = [];
  const ctx = {
    effect: () => () => {},
    get: key => key === 'sessions'
      ? { binding: id => id === 'sess-1' ? { session: { prompt: async (c, m) => { promptCalls.push({ c: Array.from(c), m }); return { ok: true }; } } } : undefined }
      : undefined,
    remote: {
      $mount: async () => {},
      cursorIntegrationUsage: {
        getSnapshot: async () => ({ ok: true, value: { active: null, keys: [], totals: [], local: {}, pool: { cycle: { elapsed: 1, days: 30, percent: 3 } } } }),
        getDisplayState: async () => ({ ok: true, value: { sessionId: 'sess-1', path: '恢复失败', keys: [] } }),
      },
    },
    slots: {
      inject: (_slot, fn) => { fn(); return () => {}; },
      register: (meta, comp) => {
        if (meta.name === 'conversation.composer.dock' && meta.id === 'cursor-integration-usage') dockComponent = comp;
        return () => {};
      },
    },
    inject: (_deps, fn) => {
      fn({
        ...ctx,
        remote: { cursorIntegrationUsage: ctx.remote.cursorIntegrationUsage },
      });
    },
  };

  await exportsObj.apply(ctx);
  assert.equal(typeof dockComponent, 'function');

  function findButtons(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'button' && node.props?.className === 'cu-retry-btn') out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(c => findButtons(c, out));
    return out;
  }

  const renderDock = overrides => dockComponent({
    sessionId: 'sess-1',
    useSession: sel => sel({ running: false, subagent: null, removed: false, openState: 'open', pendingSubmissions: [], ...overrides?.session }),
    useInput: sel => sel({ model: 'claude' }),
    useProjection: key => ({
      cursorContextRoute: { provider: 'cursor', model: 'claude' },
      cursorCompactionStatus: null,
      conversationContinuation: 88,
      inbox: { 'next-turn': [], 'next-step': [] },
      ...overrides?.projections,
    })[key],
  });

  const retryBtns = findButtons(renderDock());
  assert.equal(retryBtns.length, 1);
  await retryBtns[0].props.onClick();
  assert.deepEqual(promptCalls, [{ c: [], m: 'queue' }]);

  assert.equal(findButtons(renderDock({ projections: { conversationContinuation: null } })).length, 0);
  assert.equal(findButtons(renderDock({ session: { running: true } })).length, 0);
});
