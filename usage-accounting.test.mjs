import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSdkUsage,usageFormat} from './src/usage/normalize.js';
import {summarizeUsage} from './src/provider.js';
import {extractCalls,aggregateCalls} from './src/usage/local.js';
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
