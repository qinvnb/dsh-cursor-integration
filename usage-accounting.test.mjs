import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSdkUsage,usageFormat} from './src/usage/normalize.js';
import {summarizeUsage} from './src/provider.js';
import {extractCalls,aggregateCalls,createLocalReader,sessionFingerprint} from './src/usage/local.js';
import {sanitizeLocalUsageCache} from './src/route-storage.js';
import {CursorTransport} from './src/transport.js';

const raw={inputTokens:16551901,outputTokens:28871,cacheReadTokens:15637451,cacheWriteTokens:914410};
const normalized={...raw,inputTokens:40};
test('YY CSV fixtures reconcile all four independent rails without normalizing sums twice',()=>{
 for(const [sdk,total] of [[raw,16580772],[{inputTokens:22676582,outputTokens:55851,cacheReadTokens:22599150,cacheWriteTokens:77374},22732433]]){
  const n=normalizeSdkUsage(sdk);assert.equal(Object.values(n).reduce((a,b)=>a+b),total);
  assert.deepEqual(summarizeUsage([n]).billing,n);
 }
 assert.equal(raw.inputTokens,16551901);
});
function event(response,usage=raw){return {type:'assistant/message',time:10,data:{usage,message:{source:{replayState:{response}}}}};}
const header={type:'request/header',data:{header:{config:{provider:'cursor',model:'m'}}}};
test('historical reads convert explicit provenance only, keep unknown records outside token sums, and count host retries separately',()=>{
 const events=[header,event({usageFormat},normalized),event({sdkVersion:'1.0.40',usageFormat:'cursor-inclusive-v1'}),event({}),
 {type:'llm/retry',time:10,data:{}},event({usageFormat,attempts:[{timings:{transport:{sdkSendMs:1,sdkCreateMs:2}},upstream:{timings:{sdkSendMs:1,sdkCreateMs:2}}}]},normalized)];
 const original=JSON.stringify(events);
 const stats=aggregateCalls(extractCalls({events}),{now:20}).all;
 assert.equal(stats.calls,4);assert.equal(stats.reportedCalls,3);assert.equal(stats.uncalibratedRecords,1);
 assert.equal(stats.totalTokens,16580772*3);assert.equal(stats.hostRetries,1);
 assert.equal(stats.sdkCreates,1);assert.equal(stats.sdkSends,1);assert.equal(stats.sdkInternalRetries,null);
 assert.equal(JSON.stringify(events),original);
 const child=extractCalls({events,inheritedEventCount:events.length});assert.equal(child.length,0);
});
for(const streamed of [true,false])test('SDK ingress normalizes '+(streamed?'stream events':'final fallback')+' once and emits no duplicate usage',async()=>{
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>({
  send:async()=>({async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'ok'}]}};if(streamed)yield {type:'usage',usage:raw};},wait:async()=>({status:'finished',usage:raw})}),async [Symbol.asyncDispose](){},
 })}};
 const transport=new CursorTransport({loadSDK:async()=>sdk});
 try{const rows=[];for await(const e of transport.stream({apiKey:'fixture',model:{id:'m'},prompt:'ok',messages:[]}))rows.push(e);
  const usages=rows.filter(e=>e.type==='usage');assert.equal(usages.length,1);assert.deepEqual(usages[0].billing,normalized);
 }finally{await transport.close();}
});

test('an unknown SDK accounting shape withholds counters without failing the model response',async()=>{
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>({
  send:async()=>({async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}};yield {type:'usage',usage:{inputTokens:1,cacheReadTokens:20}};},wait:async()=>({status:'finished'})}),async [Symbol.asyncDispose](){},
 })}};
 const t=new CursorTransport({loadSDK:async()=>sdk});
 try{const events=[];for await(const e of t.stream({apiKey:'fixture',model:{id:'m'},prompt:'ok',messages:[]}))events.push(e);
  assert.ok(events.some(e=>e.type==='text'));assert.ok(events.some(e=>e.type==='usage-unavailable'));assert.ok(!events.some(e=>e.type==='usage'));
 }finally{await t.close();}
});

test('createLocalReader peek returns disk-cached stats immediately while scanning incrementally in background', async () => {
 let now = 1_700_000_000_000;
 let savedCache = null;
 const readCalls = [];
 let releaseS2;
 const makeEvents = tokens => [
  header,
  event({usageFormat}, {inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}),
 ];
 const sessions = {
  s1: {header: {id: 's1', updatedAt: 100, eventCount: 2}, events: makeEvents(1000)},
  s2: {header: {id: 's2', updatedAt: 200, eventCount: 2}, events: makeEvents(2000)},
 };
 const initialReader = createLocalReader({
  listSessions: async () => [{header: sessions.s1.header}, {header: sessions.s2.header}],
  readSession: async id => {
   readCalls.push(id);
   return {events: sessions[id].events};
  },
 }, () => now, {loadCache: () => savedCache, saveCache: v => {savedCache = v;}});

 const first = await initialReader.get();
 assert.equal(first.scanning, false);
 assert.equal(first.all.totalTokens, 3000);
 assert.deepEqual(readCalls, ['s1', 's2']);
 assert.ok(sessionFingerprint({header: sessions.s1.header}));
 assert.ok(savedCache?.sessions?.s1?.fp);

 // Restart: s1 unchanged, s2 updated & deferred, s3 deleted
 now += 120_000;
 readCalls.length = 0;
 savedCache.sessions.s3 = {fp: 'stale', calls: [{time: 10, model: 'm', failed: false, usage: {inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}, uncalibrated: false, sdkSends: 0, sdkCreates: 0, sdkResumes: 0}]};
 sessions.s2 = {header: {id: 's2', updatedAt: 300, eventCount: 3}, events: makeEvents(5000)};

 const restarted = createLocalReader({
  listSessions: async () => [{header: sessions.s1.header}, {header: sessions.s2.header}],
  readSession: async id => {
   readCalls.push(id);
   if (id === 's2') await new Promise(resolve => {releaseS2 = resolve;});
   return {events: sessions[id].events};
  },
 }, () => now, {loadCache: () => savedCache, saveCache: v => {savedCache = v;}});

 const immediate = restarted.peek();
 assert.equal(immediate.scanning, true);
 assert.equal(immediate.all.totalTokens, 3500);
 await new Promise(r => setImmediate(r));
 // s1 skipped via matching fingerprint; only s2 is read
 assert.deepEqual(readCalls, ['s2']);

 releaseS2();
 await new Promise(r => setImmediate(r));
 await new Promise(r => setImmediate(r));
 const settled = restarted.peek();
 assert.equal(settled.scanning, false);
 assert.equal(settled.all.totalTokens, 6000);
 assert.equal(savedCache.sessions.s3, undefined);
});

test('sanitizeLocalUsageCache rejects invalid structures and strips unknown fields', () => {
 assert.equal(sanitizeLocalUsageCache(null), null);
 assert.equal(sanitizeLocalUsageCache({version: 2, updatedAt: 10, sessions: {}}), null);
 assert.equal(sanitizeLocalUsageCache({version: 1, updatedAt: -1, sessions: {}}), null);
 const clean = sanitizeLocalUsageCache({
  version: 1,
  updatedAt: 500,
  extra: 'strip',
  sessions: {
   s1: {
    fp: 'fp1',
    secret: 'drop',
    calls: [{
     time: 10, model: 'claude', failed: false, extraField: 123,
     usage: {inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, extra: 9},
     uncalibrated: false, sdkSends: 1, sdkCreates: 1, sdkResumes: 0,
    }],
   },
  },
 });
 assert.deepEqual(clean, {
  version: 1,
  updatedAt: 500,
  sessions: {
   s1: {
    fp: 'fp1',
    calls: [{
     time: 10, model: 'claude', failed: false,
     usage: {inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4},
     uncalibrated: false, sdkSends: 1, sdkCreates: 1, sdkResumes: 0,
    }],
   },
  },
 });
});
