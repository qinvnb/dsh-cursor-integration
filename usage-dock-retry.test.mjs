import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { canRetryTurn, submitSessionRetry } from './src/usage/retry.js';
import { selectDockQuotas, summarizeCheckpoint, summarizeCompaction } from './src/usage/dock-model.js';

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

test('built client Dock renders single-category quota with 100% on-demand fallback and clickable Checkpoint/Compaction popups', async t => {
  const code = await readFile(new URL('./src/client.js', import.meta.url), 'utf8');
  let loaded;
  const h = (type, props, ...rawChildren) => {
    const flat = rawChildren.flat(Infinity).filter(c => c != null && c !== false && c !== true);
    const childProp = rawChildren.length === 1 ? rawChildren[0] : rawChildren.length > 1 ? flat : undefined;
    return { type, props: { ...(props ?? {}), ...(childProp !== undefined ? { children: childProp } : {}) }, children: flat };
  };
  let states = [];
  let stateIndex = 0;
  let effectDeps = [];
  let effectIndex = 0;
  const unsubs = [];
  t.after(() => { unsubs.forEach(fn => fn()); });
  let subscribed = false;
  const fakeReact = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: init => {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], v => { states[idx] = typeof v === 'function' ? v(states[idx]) : v; }];
    },
    useRef: init => ({ current: init }),
    useEffect: (fn, deps) => {
      const idx = effectIndex++;
      const prev = effectDeps[idx];
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      if (changed) {
        effectDeps[idx] = deps;
        fn();
      }
    },
    useSyncExternalStore: (sub, snap) => {
      if (!subscribed) { subscribed = true; unsubs.push(sub(() => {})); }
      return snap();
    },
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
  let displayPath = '等待本轮请求';
  let meters = [
    { key: 'auto', percent: 6.3, remaining: 93.7, unit: 'percent' },
    { key: 'api', percent: 83, remaining: 17, unit: 'percent' },
    { key: 'onDemand', percent: 12.5, used: 2.5, limit: 20, remaining: 17.5, unit: 'usd' },
  ];
  const promptCalls = [];
  const ctx = {
    effect: () => () => {},
    get: key => key === 'sessions'
      ? { binding: id => id === 'sess-1' ? { session: { prompt: async (c, m) => { promptCalls.push({ c: Array.from(c), m }); return { ok: true }; } } } : undefined }
      : undefined,
    remote: {
      $mount: async () => {},
      cursorIntegrationUsage: {
        getSnapshot: async () => ({ ok: true, value: { active: { id: 'k1', label: 'WYA' }, keys: [], totals: [], local: {}, defaultRoute: 'proxy', routes: {}, pool: { cycle: { elapsed: 1, days: 30, percent: 3 } } } }),
        getDisplayState: async () => ({
          ok: true,
          value: {
            sessionId: 'sess-1',
            path: displayPath,
            fallback: 'k1',
            keys: [{
              id: 'k1',
              label: 'WYA',
              account: {
                data: { meters },
              },
            }],
          },
        }),
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

  function expand(node) {
    if (node == null || typeof node === 'boolean' || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') {
      return expand(node.type(node.props));
    }
    return { ...node, children: Array.isArray(node.children) ? node.children.map(expand) : node.children };
  }

  function collectBarText(node, out = []) {
    if (node == null || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { node.forEach(c => collectBarText(c, out)); return out; }
    if (node.type === 'style' || (typeof node.props?.className === 'string' && node.props.className.includes('ci-popup-panel'))) return out;
    if (Array.isArray(node.children)) node.children.forEach(c => collectBarText(c, out));
    return out;
  }

  function collectText(node, out = []) {
    if (node == null || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { node.forEach(c => collectText(c, out)); return out; }
    if (node.type === 'style') return out;
    if (Array.isArray(node.children)) node.children.forEach(c => collectText(c, out));
    return out;
  }

  function findNodes(node, pred, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach(c => findNodes(c, pred, out)); return out; }
    if (pred(node)) out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(c => findNodes(c, pred, out));
    return out;
  }

  const renderDock = overrides => {
    stateIndex = 0;
    effectIndex = 0;
    return expand(dockComponent({
      sessionId: 'sess-1',
      useSession: sel => sel({ running: false, subagent: null, removed: false, openState: 'open', pendingSubmissions: [], ...overrides?.session }),
      useInput: sel => sel({ model: 'gemini-4-neon', ...overrides?.input }),
      useProjection: key => ({
        cursorContextRoute: { provider: 'cursor', model: 'gemini-4-neon', contextWindow: 1000000 },
        contextBreakdown: { systemTokens: 10000, toolsTokens: 20000, messageTokens: 203000 },
        cursorCompactionStatus: null,
        conversationContinuation: 88,
        inbox: { 'next-turn': [], 'next-step': [] },
        ...overrides?.projections,
      })[key],
    }));
  };

  // Flush initial useEffect async getDisplayState resolution
  renderDock();
  await new Promise(r => setImmediate(r));

  // Idle non-Cursor model: single category 其它模型 83% (even though onDemand is 12.5%) + clickable Checkpoint & Compaction pills
  const idleTree = renderDock();
  assert.match(idleTree.props.className, /\bcu-bar\b/);
  const idleBarText = collectBarText(idleTree).join(' ');
  assert.match(idleBarText, /23%/);
  assert.match(idleBarText, /233K\/1M/);
  assert.match(idleBarText, /WYA/);
  assert.equal(idleBarText.indexOf('WYA') < idleBarText.indexOf('23%'), true);
  assert.match(idleBarText, /其它模型 83%/);
  assert.doesNotMatch(idleBarText, /Cursor 模型/);
  assert.doesNotMatch(idleBarText, /个人按需/);
  assert.match(idleBarText, /检查点/);
  assert.match(idleBarText, /压缩/);
  const fullIdleText = collectText(idleTree).join(' ');
  assert.match(fullIdleText, /检查点详情/);
  assert.match(fullIdleText, /等待本轮请求/);
  assert.match(fullIdleText, /上下文压缩详情/);
  assert.match(fullIdleText, /尚无成功的摘要压缩记录/);
  assert.match(fullIdleText, /优先代理/);

  // Cursor model (composer-2): shows Cursor 模型 6.3% on bar
  const cursorModelTree = renderDock({
    input: { model: 'composer-2' },
    projections: { cursorContextRoute: { provider: 'cursor', model: 'composer-2', contextWindow: 1000000 } },
  });
  const cursorBarText = collectBarText(cursorModelTree).join(' ');
  assert.match(cursorBarText, /Cursor 模型 6\.3%/);
  assert.doesNotMatch(cursorBarText, /其它模型/);
  assert.doesNotMatch(cursorBarText, /个人按需/);

  // 100% exhausted primary category switches bar to 个人按需
  meters = [
    { key: 'auto', percent: 6.3, remaining: 93.7, unit: 'percent' },
    { key: 'api', percent: 100, remaining: 0, unit: 'percent' },
    { key: 'onDemand', percent: 12.5, used: 2.5, limit: 20, remaining: 17.5, unit: 'usd' },
  ];
  renderDock({ session: { running: true } });
  await new Promise(r => setImmediate(r));
  const exhaustedTree = renderDock();
  const exhaustedBarText = collectBarText(exhaustedTree).join(' ');
  assert.match(exhaustedBarText, /个人按需 12\.5%/);
  assert.doesNotMatch(exhaustedBarText, /其它模型 100%/);
  assert.match(collectText(exhaustedTree).join(' '), /其它模型（已满，切换个人按需）/);

  const retryBtns = findNodes(idleTree, n => n.type === 'button' && n.props?.className === 'cu-retry-btn');
  assert.equal(retryBtns.length, 1);
  await retryBtns[0].props.onClick();
  assert.deepEqual(promptCalls, [{ c: [], m: 'queue' }]);

  // Live error checkpoint + running compaction appear as clickable pills with details in popup & tone classes on trigger
  displayPath = '自动重连超时止损';
  renderDock({ session: { running: true } });
  await new Promise(r => setImmediate(r));
  const activeTree = renderDock({
    session: { running: false },
    projections: {
      cursorCompactionStatus: {
        status: 'running',
        started: 1732622400000,
        pruned: 1732622300000,
        prunedTokens: 12345,
      },
    },
  });
  const activeBarText = collectBarText(activeTree).join(' ');
  assert.match(activeBarText, /检查点 · 止损/);
  assert.match(activeBarText, /压缩中…/);
  assert.equal(findNodes(activeTree, n => typeof n.props?.className === 'string' && n.props.className.includes('cu-pill-error')).length > 0, true);
  assert.equal(findNodes(activeTree, n => typeof n.props?.className === 'string' && n.props.className.includes('cu-pill-busy')).length > 0, true);
  const activeFullText = collectText(activeTree).join(' ');
  assert.match(activeFullText, /自动重连超时止损/);
  assert.match(activeFullText, /工具裁剪/);
  assert.match(activeFullText, /12,345 Token/);

  assert.equal(findNodes(renderDock({ projections: { conversationContinuation: null } }), n => n.type === 'button' && n.props?.className === 'cu-retry-btn').length, 0);
  assert.equal(findNodes(renderDock({ session: { running: true } }), n => n.type === 'button' && n.props?.className === 'cu-retry-btn').length, 0);
});

test('selectDockQuotas shows only selected category and switches to onDemand strictly at 100%', () => {
  const meters = [
    { key: 'auto', percent: 12 },
    { key: 'api', percent: 95 },
    { key: 'onDemand', percent: 25 },
  ];
  assert.deepEqual(
    (() => { const q = selectDockQuotas(meters, 'auto'); return { pk: q.primaryKey, ak: q.activeKey, ex: q.primaryExhausted, pct: q.active?.percent }; })(),
    { pk: 'auto', ak: 'auto', ex: false, pct: 12 },
  );
  assert.deepEqual(
    (() => { const q = selectDockQuotas(meters, 'composer-2'); return { pk: q.primaryKey, ak: q.activeKey, ex: q.primaryExhausted, pct: q.active?.percent }; })(),
    { pk: 'auto', ak: 'auto', ex: false, pct: 12 },
  );
  assert.deepEqual(
    (() => { const q = selectDockQuotas(meters, 'gemini-4-neon'); return { pk: 'api', ak: q.activeKey, ex: q.primaryExhausted, pct: q.active?.percent }; })(),
    { pk: 'api', ak: 'api', ex: false, pct: 95 },
  );

  // At 100% on api: gemini-4-neon switches to onDemand, composer-2 stays on auto (12%)
  const apiExhausted = [
    { key: 'auto', percent: 12 },
    { key: 'api', percent: 100 },
    { key: 'onDemand', percent: 25 },
  ];
  assert.equal(selectDockQuotas(apiExhausted, 'gemini-4-neon').activeKey, 'onDemand');
  assert.equal(selectDockQuotas(apiExhausted, 'gemini-4-neon').primaryExhausted, true);
  assert.equal(selectDockQuotas(apiExhausted, 'composer-2').activeKey, 'auto');
  assert.equal(selectDockQuotas(apiExhausted, 'composer-2').primaryExhausted, false);

  // At 100% on auto: composer-2 switches to onDemand
  const autoExhausted = [
    { key: 'auto', percent: 100 },
    { key: 'api', percent: 5 },
    { key: 'onDemand', percent: 0 },
  ];
  assert.equal(selectDockQuotas(autoExhausted, 'composer-2').activeKey, 'onDemand');
  assert.equal(selectDockQuotas(autoExhausted, 'composer-2').primaryExhausted, true);
});

test('summarizeCheckpoint covers idle, normal, busy, and error states with details preserved', () => {
  assert.deepEqual(summarizeCheckpoint(null), { short: '检查点', detail: '等待本轮请求', tone: 'normal', icon: 'checkpoint' });
  assert.deepEqual(summarizeCheckpoint('等待本轮请求'), { short: '检查点', detail: '等待本轮请求', tone: 'normal', icon: 'checkpoint' });
  assert.deepEqual(summarizeCheckpoint('复用当前会话'), { short: '检查点 · 复用', detail: '复用当前会话', tone: 'normal', icon: 'checkpoint' });
  assert.deepEqual(summarizeCheckpoint('已从检查点恢复'), { short: '检查点 · 已恢复', detail: '已从检查点恢复', tone: 'normal', icon: 'checkpoint' });
  assert.deepEqual(summarizeCheckpoint('本轮新建会话'), { short: '检查点 · 新建', detail: '本轮新建会话', tone: 'normal', icon: 'checkpoint' });
  assert.deepEqual(summarizeCheckpoint('本轮按历史重建 · 历史变化'), { short: '检查点 · 重建', detail: '本轮按历史重建 · 历史变化', tone: 'normal', icon: 'checkpoint' });
  assert.deepEqual(summarizeCheckpoint('连接波动，正在第 1 次自动重连…'), { short: '自动重连…', detail: '连接波动，正在第 1 次自动重连…', tone: 'busy', icon: 'refresh' });
  assert.deepEqual(summarizeCheckpoint('正在恢复检查点'), { short: '恢复检查点…', detail: '正在恢复检查点', tone: 'busy', icon: 'refresh' });
  assert.deepEqual(summarizeCheckpoint('自动重连超时止损'), { short: '检查点 · 止损', detail: '自动重连超时止损', tone: 'error', icon: 'warning' });
  assert.deepEqual(summarizeCheckpoint('新建失败 · NetworkError'), { short: '检查点 · 失败', detail: '新建失败 · NetworkError', tone: 'error', icon: 'warning' });
});

test('summarizeCompaction covers idle, running, cancelled, failed, pruned, and summarized states', () => {
  const fmt = t => `T${t}`;
  assert.deepEqual(summarizeCompaction(null, fmt), { short: '压缩', detail: '尚无成功的摘要压缩记录', tone: 'normal', icon: 'compress' });
  assert.deepEqual(summarizeCompaction({ status: 'running' }, fmt), { short: '压缩中…', detail: '正在生成摘要，请稍候', tone: 'busy', icon: 'refresh' });
  assert.deepEqual(summarizeCompaction({ status: 'failed', error: '已取消压缩' }, fmt), { short: '压缩 · 已取消', detail: '已取消压缩', tone: 'normal', icon: 'compress' });
  assert.deepEqual(summarizeCompaction({ status: 'failed', error: 'Cursor 限流' }, fmt), { short: '压缩失败', detail: '压缩失败 · Cursor 限流', tone: 'error', icon: 'warning' });
  assert.deepEqual(summarizeCompaction({ status: 'summarized', summarized: 123 }, fmt), { short: '压缩 · 已完成', detail: '摘要压缩已完成 · T123', tone: 'normal', icon: 'compress' });
  assert.deepEqual(summarizeCompaction({ status: 'idle', pruned: 456 }, fmt), { short: '压缩 · 已裁剪', detail: '尚无成功的摘要压缩记录', tone: 'normal', icon: 'compress' });
});

test('built settings Panel displays cached per-account quotas from data.keys without clicking refreshAll', async t => {
  const code = await readFile(new URL('./src/client.js', import.meta.url), 'utf8');
  let loaded;
  const h = (type, props, ...rawChildren) => {
    const flat = rawChildren.flat(Infinity).filter(c => c != null && c !== false && c !== true);
    const childProp = rawChildren.length === 1 ? rawChildren[0] : rawChildren.length > 1 ? flat : undefined;
    return { type, props: { ...(props ?? {}), ...(childProp !== undefined ? { children: childProp } : {}) }, children: flat };
  };
  let states = [];
  let stateIndex = 0;
  let effectDeps = [];
  let effectIndex = 0;
  const unsubs = [];
  t.after(() => { unsubs.forEach(fn => fn()); });
  let subscribed = false;
  const fakeReact = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: init => {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], v => { states[idx] = typeof v === 'function' ? v(states[idx]) : v; }];
    },
    useRef: init => ({ current: init }),
    useEffect: (fn, deps) => {
      const idx = effectIndex++;
      const prev = effectDeps[idx];
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      if (changed) {
        effectDeps[idx] = deps;
        fn();
      }
    },
    useSyncExternalStore: (sub, snap) => {
      if (!subscribed) { subscribed = true; unsubs.push(sub(() => {})); }
      return snap();
    },
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
    window: { __ModuleLoader__: { load(entry) { loaded = entry; } } },
  };
  t.after(() => { for (const id of timers) { clearInterval(id); clearTimeout(id); } });
  vm.runInNewContext(code, sandbox);
  const exportsObj = loaded.factory(id => (id === 'react' ? fakeReact : fakePrimitives));

  let panelComponent;
  const cachedKeys = [
    {
      id: 'k1',
      label: 'WYA',
      keyHint: '已缓存',
      account: {
        status: 'ready',
        fetchedAt: 1732622400000,
        data: {
          membership: 'pro',
          periodStart: '2026-11-23T00:00:00.000Z',
          periodEnd: '2026-12-23T00:00:00.000Z',
          meters: [
            { key: 'auto', percent: 11, remaining: 89, unit: 'percent' },
            { key: 'api', percent: 45, remaining: 55, unit: 'percent' },
            { key: 'onDemand', percent: 25, used: 5, limit: 20, remaining: 15, unit: 'usd' },
          ],
        },
      },
    },
    {
      id: 'k2',
      label: 'YYJ',
      keyHint: '已缓存',
      account: {
        status: 'ready',
        fetchedAt: 1732622400000,
        data: {
          membership: 'pro',
          periodStart: '2026-11-23T00:00:00.000Z',
          periodEnd: '2026-12-23T00:00:00.000Z',
          meters: [
            { key: 'auto', percent: 3, remaining: 97, unit: 'percent' },
            { key: 'api', percent: 72, remaining: 28, unit: 'percent' },
            { key: 'onDemand', percent: 0, used: 0, limit: 20, remaining: 20, unit: 'usd' },
          ],
        },
      },
    },
  ];
  const ctx = {
    effect: () => () => {},
    get: () => undefined,
    remote: {
      $mount: async () => {},
      cursorIntegrationUsage: {
        getSnapshot: async () => ({
          ok: true,
          value: {
            active: cachedKeys[0],
            account: cachedKeys[0].account,
            keys: cachedKeys,
            totals: [],
            local: {},
            pool: { manual: false, cycle: { elapsed: 4, days: 30, percent: 13.3 }, refreshMinutes: 5 },
          },
        }),
        getRouteChecks: async () => ({ ok: true, value: { running: false, rows: [] } }),
      },
    },
    slots: {
      inject: (_slot, fn) => { fn(); return () => {}; },
      register: (meta, comp) => {
        if (meta.name === 'settings.section' && meta.id === 'cursor-integration-usage') panelComponent = comp;
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
  assert.equal(typeof panelComponent, 'function');

  function expand(node) {
    if (node == null || typeof node === 'boolean' || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, children: Array.isArray(node.children) ? node.children.map(expand) : node.children };
  }
  function collectText(node, out = []) {
    if (node == null || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { node.forEach(c => collectText(c, out)); return out; }
    if (node.type === 'style') return out;
    if (Array.isArray(node.children)) node.children.forEach(c => collectText(c, out));
    return out;
  }

  const renderPanel = () => {
    stateIndex = 0;
    effectIndex = 0;
    return expand(panelComponent());
  };

  renderPanel();
  await new Promise(r => setImmediate(r));
  const tree = renderPanel();
  const text = collectText(tree).join(' ');
  assert.match(text, /WYA/);
  assert.match(text, /YYJ/);
  assert.match(text, /45%/);
  assert.match(text, /72%/);
  assert.match(text, /25%/);
  assert.doesNotMatch(text, /点击上方按钮查询所有已保存的密钥/);
});
