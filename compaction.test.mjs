import test from 'node:test';
import assert from 'node:assert/strict';
import {defineAdapter} from './src/adapter.js';
import {buildCompactionPrompt} from './src/compaction-prompt.js';

test('compaction accepts size guidance, isolates summary and removes executable tools',async()=>{
 const requests=[];const Adapter=defineAdapter({LlmAdapter:class{},credential:async()=>'test',profile:()=>({}),transport:{catalog:async()=>[{id:'test',parameters:[],variants:[]}],async *stream(r){requests.push(r);yield {type:'text',text:'summary'};}}});
 const options={model:'test',purpose:'compaction',maxTokens:65536,sessionId:'live',tools:[{name:'write'}],messages:[{role:'user',content:[{type:'text',text:'Old task'}]},{role:'user',content:[{type:'text',text:'Summarize current state'}]}]};
 const events=[];for await(const e of new Adapter().stream(options))events.push(e);
 assert.equal(requests.length,1);assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].continuation,undefined);assert.equal(requests[0].purpose,'compaction');assert.match(requests[0].prompt,/Create a conversation checkpoint only/);assert.match(requests[0].prompt,/Summarize current state/);assert.equal(events.at(-1).reason.kind,'stop');assert.equal(events.at(-1).replayState.response.attempts[0].compaction.limitMode,'prompt-guidance');
 assert.equal(events.at(-1).replayState.response.attempts[0].compaction.stage,1);
 for(const extra of [{purpose:undefined},{temperature:0}]){const out=[];for await(const e of new Adapter().stream({...options,...extra}))out.push(e);assert.equal(out.at(-1).reason.failure.code,'UNSUPPORTED_CONTROL');}assert.equal(requests.length,1);
});

test('buildCompactionPrompt strips reasoning, unwraps tool args, preserves user/assistant prose & recent tail, and adapts under maxPromptChars',()=>{
 const hugeWrite='X'.repeat(5000);
 const hugeOutput='Y'.repeat(5000);
 const messages=[
  {role:'user',content:[{type:'text',text:'FIRST USER GOAL'}]},
  {role:'assistant',content:[{type:'reasoning',text:'HIDDEN THINKING'},{type:'text',text:'OLD ASSISTANT CONCLUSION'},{type:'tool-call',id:'c1',name:'write',arguments:JSON.stringify({path:'/a/b.ts',content:hugeWrite})}]},
  {role:'tool',toolCallId:'c1',content:[{type:'text',text:hugeOutput}]},
  ...Array.from({length:24},(_,i)=>({role:i%2===0?'user':'assistant',content:[{type:'text',text:'RECENT_'+i}]})),
  {role:'user',content:[{type:'text',text:'Summarize now'}]},
 ];
 const stage1=buildCompactionPrompt({messages,maxTokens:32000,recentCount:24});
 assert.equal(stage1.stats.stage,1);
 assert.equal(stage1.stats.droppedReasoningBlocks,1);
 assert.ok(stage1.stats.truncatedToolBlocks>=2);
 assert.doesNotMatch(stage1.text,/HIDDEN THINKING/);
 assert.match(stage1.text,/FIRST USER GOAL/);
 assert.match(stage1.text,/OLD ASSISTANT CONCLUSION/);
 assert.match(stage1.text,/\/a\/b\.ts/);
 assert.match(stage1.text,/RECENT_23/);
 assert.ok(stage1.text.includes('omitted'));
 assert.ok(stage1.stats.promptChars<stage1.stats.rawChars);

 const stage3=buildCompactionPrompt({messages,maxTokens:32000,maxPromptChars:600,recentCount:4});
 assert.equal(stage3.stats.stage,3);
 assert.match(stage3.text,/FIRST USER GOAL/);
 assert.match(stage3.text,/OLD ASSISTANT CONCLUSION/);
 assert.match(stage3.text,/\[tool output omitted: 5000 chars\]/);
 assert.match(stage3.text,/RECENT_23/);
});
