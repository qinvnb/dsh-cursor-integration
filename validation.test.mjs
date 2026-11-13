import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {createToolValidator} from './src/validation.js';
import {NativeBridge} from './src/native.js';
import {CursorTransport} from './src/transport.js';
import {defineAdapter} from './src/adapter.js';

const tool={name:'write_file',parameters:{type:'object',required:['path','text'],additionalProperties:false,properties:{path:{type:'string'},text:{type:'string'}}}};
const setup=()=>{const events=[];const bridge=new NativeBridge([tool],createToolValidator(Ajv),event=>events.push(event));return {bridge,events,execute:args=>bridge.customTools.write_file.execute(args)};};
const history=event=>[{role:'assistant',content:[{type:'tool-call',id:event.id,name:event.name,arguments:event.arguments}]},{role:'tool',toolCallId:event.id,content:[{type:'text',text:'host result'}]}];

test('invalid parameters return a corrective SDK tool result without host execution or leaked values',async()=>{
 const {bridge,events,execute}=setup();
 const result=await execute({path:42,text:'PRIVATE_SECRET_VALUE'});
 assert.equal(result.isError,true);assert.equal(bridge.pending.size,0);assert.ok(!events.some(e=>e.type==='failure'||e.type==='tool-call'));
 const payload=JSON.parse(result.content[0].text);assert.equal(payload.issues[0].field,'/path');assert.equal(payload.issues[0].expectedType,'string');
 assert.ok(!JSON.stringify([result,events]).includes('PRIVATE_SECRET_VALUE'));
 const missing=JSON.parse((await execute({path:'PRIVATE_PATH'})).content[0].text);assert.equal(missing.issues[0].requiredField,'text');
 bridge.close();
});

test('corrected call uses the ordinary host handoff and completes exactly once',async()=>{
 const {bridge,events,execute}=setup();await execute({});
 const pending=execute({path:'test.txt',text:'hello'});const call=events.find(e=>e.type==='tool-call');
 assert.equal(bridge.pending.size,1);bridge.resume(history(call),[call.id]);assert.equal((await pending).content[0].text,'host result');
 assert.equal(events.filter(e=>e.type==='tool-call').length,1);assert.throws(()=>bridge.resume(history(call),[call.id]));bridge.close();
});

test('two correction opportunities are bounded even with parallel invalid calls; later valid calls cannot bypass the limit',async()=>{
 const {bridge,events,execute}=setup();const results=await Promise.allSettled([execute({}),execute({}),execute({}),execute({path:'x',text:'x'})]);
 assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled','rejected','rejected']);
 assert.equal(results[2].reason.code,'INVALID_ARGUMENTS');assert.equal(events.filter(e=>e.type==='failure').length,1);assert.equal(bridge.pending.size,0);
 bridge.close();
});

test('cancelled bridge cannot enqueue a corrected call and a new run resets only the correction budget',async()=>{
 const {bridge,execute}=setup();await execute(null);await execute([]);assert.equal(bridge.validationFailures,2);
 bridge.beginRun();assert.equal(bridge.validationFailures,0);assert.equal((await execute({})).isError,true);
 bridge.close();await assert.rejects(execute({path:'x',text:'x'}),{code:'ABORTED'});assert.equal(bridge.pending.size,0);
});

test('invalid tool schemas fail separately and never expose compiler exceptions',async()=>{
 const events=[];const bridge=new NativeBridge([{name:'bad',parameters:{type:'PRIVATE_INVALID_SCHEMA'}}],createToolValidator(Ajv),e=>events.push(e));
 await assert.rejects(bridge.customTools.bad.execute({private:'PRIVATE_ARGUMENT'}),e=>e.code==='INVALID_TOOL_SCHEMA'&&!e.message.includes('PRIVATE_'));
 assert.equal(events[0].type,'failure');assert.equal(bridge.validationFailures,0);bridge.close();
});

test('transport continues the same SDK run after correction and host approval without replaying a write',async()=>{
 let options,writes=0,disposed=0,sends=0;
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async opts=>{options=opts;return {
   send:async()=>{sends++;return {status:'running',supports:()=>false,
     async *stream(){assert.equal((await options.local.customTools.write_file.execute({})).isError,true);
       const result=await options.local.customTools.write_file.execute({path:'test.txt',text:'hello'},{toolCallId:'sdk-call'});
       assert.equal(result.content[0].text,'host result');
       yield {type:'assistant',message:{content:[{type:'text',text:'done'}]}};
     },wait:async()=>({status:'finished'})};},[Symbol.asyncDispose]:async()=>{disposed++;},
 };}}};
 const transport=new CursorTransport({loadSDK:async()=>sdk,timeoutMs:5000});
 const request={apiKey:'fake-key',model:{id:'test'},tools:[tool],validate:createToolValidator(Ajv),messages:[{role:'user',content:[{type:'text',text:'write once'}]}],prompt:'write once'};
 try {
  const first=[];for await(const event of transport.stream(request))first.push(event);
  assert.equal(first.filter(e=>e.type==='validation-error').length,1);const call=first.find(e=>e.type==='tool-call');assert.ok(call);
  writes++;const continuation=first.find(e=>e.type==='continuation').token;
  const second=[];for await(const event of transport.stream({...request,continuation,messages:[...request.messages,...history(call)]}))second.push(event);
  assert.equal(second.find(e=>e.type==='text').text,'done');assert.equal(writes,1);assert.equal(sends,1);assert.equal(disposed,1);
 } finally {await transport.close();}
});

test('adapter persists only the safe validation diagnostics for support',async()=>{
 const Adapter=defineAdapter({LlmAdapter:class{},credential:async()=>'fake-key',profile:()=>({}),transport:{catalog:async()=>[{id:'test',parameters:[],variants:[]}],async *stream(){
   yield {type:'validation-error',tool:'write_file',issues:[{field:'/path',rule:'type',expectedType:'string'}],correction:1};yield {type:'text',text:'corrected'};
 }}});
 const events=[];for await(const event of new Adapter().stream({model:'test',messages:[]}))events.push(event);
 const record=events.find(e=>e.type==='finish').replayState.response.attempts[0];assert.equal(record.validationErrors[0].tool,'write_file');
 assert.equal(record.validationErrors[0].issues[0].field,'/path');
});
