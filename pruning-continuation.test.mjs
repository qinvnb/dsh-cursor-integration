import test from 'node:test';
import assert from 'node:assert/strict';
import {CursorTransport} from './src/transport.js';
import {isPrunedHistory} from './src/native.js';
import {buildCursorPrompt} from './src/request-context.js';
const marker='\n\n[... tool result middle pruned ...]\n\n';
const user=text=>({role:'user',content:[{type:'text',text}]});
const oldResult={role:'tool',toolCallId:'old-read',content:[{type:'text',text:'HEAD'+'x'.repeat(100)+'TAIL'}]};
const prunedResult={...oldResult,content:[{type:'text',text:'HEAD'+marker+'TAIL'}]};

function fixture() {
 const seen={creates:0,calls:0,results:[],options:[],disposed:0};
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async options=>{
  const index=++seen.creates;seen.options.push(options);
  return {send:async()=>({supports:()=>false,async *stream(){
   if(index===1){seen.calls++;seen.results.push(await options.local.customTools.write.execute({path:'one.txt'}));}
   yield {type:'assistant',message:{content:[{type:'text',text:'Recorded result received'}]}};
  },wait:async()=>({status:'finished'})}),[Symbol.asyncDispose]:async()=>{seen.disposed++;}};
 }}};
 return {seen,transport:new CursorTransport({loadSDK:async()=>sdk,timeoutMs:3000})};
}
async function collect(transport,request){const output=[];for await(const event of transport.stream(request))output.push(event);return output;}
async function handoff(transport){
 const messages=[user('write once'),oldResult];
 const request={apiKey:'fake',model:{id:'test'},sessionId:'session',messages,prompt:buildCursorPrompt({messages}),tools:[{name:'write',parameters:{}}],validate:()=>true};
 const first=await collect(transport,request);
 const call=first.find(e=>e.type==='tool-call');
 return {request,call,token:first.find(e=>e.type==='continuation').token};
}
function continued(base,prefix){
 const messages=[...prefix,{role:'assistant',content:[base.call]},{role:'tool',toolCallId:base.call.id,content:[{type:'text',text:'File already written'}]}];
 return {...base.request,messages,continuation:base.token,prompt:buildCursorPrompt({messages})};
}

test('DSH middle pruning accepts rich blocks and rejects edits to retained text, calls and user messages',()=>{
 assert.ok(isPrunedHistory([oldResult],[prunedResult]));
 assert.equal(isPrunedHistory([oldResult],[{...prunedResult,toolCallId:'different'}]),false);
 assert.equal(isPrunedHistory([oldResult],[{...prunedResult,content:[{type:'text',text:'EDIT'+marker+'TAIL'}]}]),false);
 assert.equal(isPrunedHistory([user('original')],[user('edited')]),false);
 const image={type:'image',attachment:{attachmentId:'image'}};
 const before={...oldResult,content:[{type:'text',text:'HEAD'+'x'.repeat(50)},image,{type:'text',text:'x'.repeat(50)+'TAIL'}]};
 const after={...before,content:[{type:'text',text:'HEAD'+marker},image,{type:'text',text:'TAIL'}]};
 assert.ok(isPrunedHistory([before],[after]));
 assert.equal(isPrunedHistory([before],[{...after,content:after.content.filter(b=>b.type!=='image')}]),false);
});

test('pruning during a pending write resumes once, then releases the old SDK history',async()=>{
 const {transport,seen}=fixture();
 try {
  const base=await handoff(transport);
  const request=continued(base,[user('write once'),prunedResult]);
  const output=await collect(transport,request);
  assert.equal(seen.creates,1);assert.equal(seen.calls,1);assert.equal(seen.results.length,1);
  assert.equal(seen.results[0].content[0].text,'File already written');
  assert.equal(seen.disposed,1);
  assert.ok(output.some(e=>e.type==='text'));
  await assert.rejects(collect(transport,request),{code:'CONTINUATION_UNAVAILABLE'});
  const messages=[...request.messages,{role:'assistant',content:[{type:'text',text:'Recorded result received'}]},user('next task')];
  await collect(transport,{...base.request,messages,prompt:buildCursorPrompt({messages})});
  assert.equal(seen.creates,2);
 } finally {await transport.close();}
});

test('real history replacement consumes recorded results through tool-free recovery',async()=>{
 const {transport,seen}=fixture();
 try {
  const base=await handoff(transport);
  const output=await collect(transport,continued(base,[user('New compacted checkpoint')]));
  assert.equal(seen.creates,2);assert.equal(seen.calls,1);
  assert.deepEqual(seen.options[1].tools,[]);
  assert.deepEqual(seen.options[1].local.customTools,{});
  assert.ok(output.some(e=>e.type==='text'));
 } finally {await transport.close();}
});

test('rewritten history with altered pending arguments cannot replay a tool or start recovery',async()=>{
 const {transport,seen}=fixture();
 try {
  const base=await handoff(transport);
  const request=continued({...base,call:{...base.call,arguments:'{"path":"other.txt"}'}},[user('checkpoint')]);
  await assert.rejects(collect(transport,request),{code:'TOOL_RESULT_MISMATCH'});
  assert.equal(seen.creates,1);assert.equal(seen.calls,1);
 } finally {await transport.close();}
});
