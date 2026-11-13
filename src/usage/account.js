import { Agent, ProxyAgent, fetch as directFetch } from 'undici';

const number = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

// Deliberately whitelist the public projection; raw account responses never reach clients.
export function normalizeAccount(payload) {
  const usage = payload?.individualUsage;
  if (!usage || typeof usage !== 'object') throw new Error('UNSUPPORTED_USAGE');
  const meters = [];
  const cents = (key, label, bucket) => {
    if (!bucket || bucket.enabled === false) return;
    const used = number(bucket.used), limit = number(bucket.limit), reported = number(bucket.remaining);
    if (used === null && reported === null) return;
    meters.push({key, label, unit: 'usd', used: used === null ? null : used / 100,
      limit: limit === null ? null : limit / 100,
      remaining: reported !== null ? reported / 100 : used !== null && limit !== null ? Math.max(0, limit - used) / 100 : null,
      percent: used !== null && limit !== null && limit > 0 ? used / limit * 100 : null});
  };
  const plan = usage.plan;
  if (usage.overall?.enabled !== false && number(usage.overall?.used) !== null) {
    cents('overall', '套餐用量', usage.overall);
  }
  if (plan?.enabled !== false && plan) {
    const auto = number(plan.autoPercentUsed), api = number(plan.apiPercentUsed);
    if (auto !== null || api !== null) {
      for (const [key, label, percent] of [['auto', 'Cursor 模型', auto], ['api', '其他模型（Claude 等）', api]]) {
        if (percent !== null) meters.push({key, label, unit: 'percent', used: percent, limit: 100, remaining: Math.max(0, 100 - percent), percent});
      }
      // Do not multiply these rails by plan.limit: they are separate pools.
    } else cents('plan', '套餐用量', plan);
  }
  cents('onDemand', '按量付费', usage.onDemand);
  if (!meters.length) throw new Error('UNSUPPORTED_USAGE');
  return {membership: typeof payload.membershipType === 'string' ? payload.membershipType.slice(0, 48) : null,
    periodStart: date(payload.billingCycleStart), periodEnd: date(payload.billingCycleEnd), meters};
}

export function createAccountReader({credential, proxyUrl, fetchImpl = directFetch, now = Date.now}) {
  const direct = new Agent();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  let cached, pending, auth, stopped = false;
  const controller = new AbortController();
  const read = async (url, key, post = false) => {
    const send = (route, timeout) => fetchImpl(url, {method: post ? 'POST' : 'GET', redirect: 'error',
      headers: {Authorization: `Bearer ${key}`, Accept: 'application/json', ...(post ? {'Content-Type': 'application/json'} : {})},
      ...(post ? {body: '{}'} : {}), dispatcher:route,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])});
    let response;
    try {response=await send(direct,6000);} catch(error) {
      if(controller.signal.aborted || !dispatcher) throw error;
      response=await send(dispatcher,15000);
    }
    if (!response.ok) { await response.body?.cancel?.(); const error = new Error('HTTP_ERROR'); error.status = response.status; throw error; }
    return response.json();
  };
  return {
    async get({force = false} = {}) {

      if (pending) return pending;
      if (stopped) return {status: 'error', error: '插件已停止', checkedAt: now(), data: null, fetchedAt: null};
      pending = (async () => {
        try {
          const key = await credential();
          if (!key) throw new Error('NO_CREDENTIAL');
          if (!auth || auth.key !== key || auth.expires <= now()) {
            const exchange = await read('https://api2.cursor.sh/auth/exchange_user_api_key', key, true);
            if (typeof exchange.accessToken !== 'string' || !exchange.accessToken) throw new Error('NO_ACCESS_TOKEN');
            auth = {key, token: exchange.accessToken, expires: now() + 10 * 60000};
          }
          const data = normalizeAccount(await read('https://api2.cursor.sh/auth/usage-summary', auth.token));
          cached = {status: 'ready', data, error: null, checkedAt: now(), fetchedAt: now()};
        } catch (error) {
          if (error.status === 401 || error.status === 403) auth = undefined;
          const message = error.message === 'NO_CREDENTIAL' ? '未找到 Cursor 凭据，请先配置 Cursor 模型插件。'
            : error.status === 401 || error.status === 403 ? '凭据已失效或没有查看用量的权限，请更新 Cursor API Key。'
            : error.message === 'UNSUPPORTED_USAGE' ? 'Cursor 返回的用量格式暂不支持，请在官网核对。'
            : error.status === 429 ? '查询过于频繁，请稍后刷新。' : '用量查询暂时失败，请检查 7890 代理后重试。';
          cached = {status: 'error', error: message, data: cached?.data ?? null, fetchedAt: cached?.fetchedAt ?? null, checkedAt: now()};
        }
        return cached;
      })().finally(() => {pending = undefined;});
      return pending;
    },
    async close() {stopped = true; controller.abort(); auth = undefined; await Promise.all([direct.destroy(),dispatcher?.destroy()]);},
  };
}
