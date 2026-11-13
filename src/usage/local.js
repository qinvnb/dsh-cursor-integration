const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const empty = () => ({calls: 0, failed: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0});
function add(target, entry) {
  target.calls++; if (entry.failed) target.failed++;
  if (entry.usage) {
    target.reportedCalls++;
    for (const field of fields) target[field] += Number.isSafeInteger(entry.usage[field]) && entry.usage[field] >= 0 ? entry.usage[field] : 0;
    target.totalTokens = fields.reduce((n, k) => n + target[k], 0);
  }
}

export function extractCalls(snapshot) {
  let config;
  const calls = [];
  // Read headers in the inherited prefix for routing, but never count inherited charges twice.
  for (let i = 0; i < snapshot.events.length; i++) {
    const event = snapshot.events[i];
    if (event.type === 'request/header') config = event.data.header.config;
    if (i < (snapshot.inheritedEventCount ?? 0) || config?.provider !== 'cursor') continue;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    let usage = event.data.usage;
    if (!usage) {
      for (const record of event.data.stream ?? []) {
        const item = record.chunk ?? record.event ?? record;
        if (item.type === 'usage') usage = item.usage;
      }
    }
    const failure = event.data.stream?.some(record => {
      const item = record.chunk ?? record.event ?? record;
      return item.type === 'finish' && ['error', 'aborted'].includes(item.reason?.kind);
    }) ?? false;
    calls.push({time: event.time, model: config.model ?? 'unknown', failed: failure, usage});
  }
  return calls;
}

export function aggregateCalls(calls, {now = Date.now(), periodStart, periodEnd} = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = periodStart ? Date.parse(periodStart) : new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const end = periodEnd ? Date.parse(periodEnd) : Infinity;
  const totals = {today: empty(), cycle: empty(), all: empty()};
  const models = new Map();
  for (const call of calls) {
    add(totals.all, call);
    if (call.time >= today.getTime() && call.time <= now) add(totals.today, call);
    if (call.time >= start && call.time < end && call.time <= now) {
      add(totals.cycle, call);
      if (!models.has(call.model)) models.set(call.model, {model: call.model, ...empty()});
      add(models.get(call.model), call);
    }
  }
  return {...totals, models: [...models.values()].sort((a,b) => b.calls-a.calls),
    cycleStart: new Date(start).toISOString(), cycleSource: periodStart ? 'account' : 'calendar', cost: null};
}

export function createLocalReader(query, clock = Date.now) {
  let cached, pending;
  return {async get(account) {
    const cycle = account?.periodStart ?? '';
    if (cached && cached.cycle === cycle && clock() - cached.checkedAt < 60000) return cached.data;
    if (pending) return pending;
    pending = (async () => {
      const calls = []; let skippedSessions = 0;
      const records = await query.listSessions();
      for (const record of records) {
        try {calls.push(...extractCalls(await query.readSession(record.header.id)));}
        catch {skippedSessions++;}
      }
      const data = {...aggregateCalls(calls, {now: clock(), periodStart: account?.periodStart, periodEnd: account?.periodEnd}),
        scannedSessions: records.length - skippedSessions, skippedSessions, checkedAt: clock(), error: null};
      cached = {cycle, checkedAt: clock(), data};
      return data;
    })().catch(() => ({error: 'DSH 历史统计暂时不可用', checkedAt: clock()})).finally(() => {pending = undefined;});
    return pending;
  }};
}
