import {normalizeSdkUsage,usageFormat} from './normalize.js';
import {sanitizeLocalUsageCache} from '../route-storage.js';
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const empty = () => ({calls: 0, failed: 0, reportedCalls: 0, uncalibratedRecords:0, sdkSends:0,sdkCreates:0,sdkResumes:0,hostRetries:0,sdkInternalRetries:null,inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0});
const fpFields=['updatedAt','lastModified','mtime','mtimeMs','eventCount','eventsCount','size','byteLength','lastEventTime','lastEventAt','lastEventId','lastSeq','seq','revision','version'];
export function sessionFingerprint(record) {
  if(!record||typeof record!=='object')return null;
  const parts=[];
  for(const [prefix,src] of [['r',record],['h',record.header],['m',record.meta],['s',record.stats]]){
    if(!src||typeof src!=='object')continue;
    for(const key of fpFields){
      const val=src[key];
      if(val!==undefined&&val!==null&&(typeof val==='string'||typeof val==='number'||typeof val==='boolean')){
        parts.push(prefix+'.'+key+'='+val);
      }
    }
  }
  return parts.length?parts.join('|'):null;
}
function add(target, entry) {
  if(entry.kind==='retry'){target.hostRetries++;return;}
  target.calls++; if (entry.failed) target.failed++;
  if(entry.uncalibrated)target.uncalibratedRecords++;
  for(const key of ['sdkSends','sdkCreates','sdkResumes'])target[key]+=entry[key]??0;
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
    if(event.type==='llm/retry'){calls.push({kind:'retry',time:event.time,model:config.model??'unknown'});continue;}
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const chunks=(event.data.stream??[]).map(record=>record.chunk??record.event??record);
    const response=chunks.findLast(item=>item.type==='finish')?.replayState?.response??event.data.message?.source?.replayState?.response;
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
    const hadUsage=Boolean(usage)||Boolean(response?.usageUnavailable);
    if(response?.usageUnavailable)usage=undefined;
    if(usage && response?.usageFormat!==usageFormat){
      if(response?.sdkVersion==='1.0.40' && response?.usageFormat==='cursor-inclusive-v1'){
        try{usage=normalizeSdkUsage(usage);}catch{usage=undefined;}
      }else usage=undefined;
    }
    const stages=(response?.attempts??[]).map(a=>a.timings?.transport??{});
    const count=key=>stages.filter(stage=>Number.isFinite(stage[key])).length;
    calls.push({time: event.time, model: config.model ?? 'unknown', failed: failure, usage,
      uncalibrated:hadUsage&&!usage,sdkSends:count('sdkSendMs'),sdkCreates:count('sdkCreateMs'),sdkResumes:count('sdkResumeMs')});
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

export function createLocalReader(query, clock = Date.now, {loadCache = () => null, saveCache = () => {}} = {}) {
  const hydrated = sanitizeLocalUsageCache(loadCache());
  const sessionCache = new Map(Object.entries(hydrated?.sessions ?? {}));
  let diskUpdatedAt = hydrated?.updatedAt ?? null;
  let cached, pending;
  const reader = {
    async get(account) {
      const cycle = account?.periodStart ?? '';
      if (cached && cached.cycle === cycle && clock() - cached.checkedAt < 60000) return cached.data;
      if (pending) return pending;
      pending = (async () => {
        const calls = []; let skippedSessions = 0;
        const records = await query.listSessions();
        const nextSessions = new Map();
        for (const record of records) {
          const id = record?.header?.id;
          const fp = sessionFingerprint(record);
          const hit = id && fp && sessionCache.get(id)?.fp === fp;
          if (hit) {
            const sessionCalls = sessionCache.get(id).calls;
            nextSessions.set(id, {fp, calls: sessionCalls});
            calls.push(...sessionCalls);
            continue;
          }
          try {
            const sessionCalls = extractCalls(await query.readSession(id));
            if (id) nextSessions.set(id, {fp, calls: sessionCalls});
            calls.push(...sessionCalls);
          } catch {
            skippedSessions++;
            if (id && sessionCache.has(id)) nextSessions.set(id, sessionCache.get(id));
          }
        }
        sessionCache.clear();
        for (const [id, entry] of nextSessions) sessionCache.set(id, entry);
        const nowTs = clock();
        diskUpdatedAt = nowTs;
        try {
          const payload = sanitizeLocalUsageCache({version: 1, updatedAt: nowTs, sessions: Object.fromEntries(nextSessions)});
          if (payload) saveCache(payload);
        } catch {}
        const data = {...aggregateCalls(calls, {now: nowTs, periodStart: account?.periodStart, periodEnd: account?.periodEnd}),
          scannedSessions: records.length - skippedSessions, skippedSessions, checkedAt: nowTs, error: null, scanning: false};
        cached = {cycle, checkedAt: nowTs, data};
        return data;
      })().catch(() => ({error: 'DSH 历史统计暂时不可用', checkedAt: clock(), scanning: false})).finally(() => {pending = undefined;});
      return pending;
    },
    peek(account) {
      const cycle = account?.periodStart ?? '';
      const nowTs = clock();
      if (cached && cached.cycle === cycle && nowTs - cached.checkedAt < 60000) {
        return {...cached.data, scanning: false};
      }
      void reader.get(account).catch(() => {});
      if (cached?.data) return {...cached.data, scanning: true};
      if (sessionCache.size > 0) {
        const allCalls = [];
        for (const entry of sessionCache.values()) allCalls.push(...entry.calls);
        return {
          ...aggregateCalls(allCalls, {now: nowTs, periodStart: account?.periodStart, periodEnd: account?.periodEnd}),
          scannedSessions: sessionCache.size, skippedSessions: 0, checkedAt: diskUpdatedAt, error: null, scanning: true,
        };
      }
      return {scanning: true, checkedAt: null, error: null};
    },
  };
  return reader;
}
