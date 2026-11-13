import test from 'node:test';
import assert from 'node:assert/strict';
import {defineAdapter} from './src/adapter.js';
test('compaction accepts size guidance, isolates summary and removes executable tools',async()=>{
 const requests=[];const Adapter=defineAdapter({LlmAdapter:class{},credential:async()=>'test',profile:()=>({}),transport:{catalog:async()=>[{id:'test',parameters:[],variants:[]}],async *stream(r){requests.push(r);yield {type:'text',text:'summary'};}}});
 const options={model:'test',purpose:'compaction',maxTokens:65536,sessionId:'live',tools:[{name:'write'}],messages:[{role:'user',content:[{type:'text',text:'Old task'}]},{role:'user',content:[{type:'text',text:'Summarize current state'}]}]};
 const events=[];for await(const e of new Adapter().stream(options))events.push(e);
 assert.equal(requests.length,1);assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].continuation,undefined);assert.equal(requests[0].purpose,'compaction');assert.match(requests[0].prompt,/Create a conversation checkpoint only/);assert.match(requests[0].prompt,/Summarize current state/);assert.equal(events.at(-1).reason.kind,'stop');assert.equal(events.at(-1).replayState.response.attempts[0].compaction.limitMode,'prompt-guidance');
 for(const extra of [{purpose:undefined},{temperature:0}]){const out=[];for await(const e of new Adapter().stream({...options,...extra}))out.push(e);assert.equal(out.at(-1).reason.failure.code,'UNSUPPORTED_CONTROL');}assert.equal(requests.length,1);
});
