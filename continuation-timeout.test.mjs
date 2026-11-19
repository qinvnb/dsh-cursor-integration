import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {CursorTransport} from './src/transport.js';
import {ProviderError} from './src/provider.js';

const timeoutMs=180;
const user=text=>({role:'user',content:[{type:'text',text}]});
const read=async(transport,request)=>{
  const events=[];
  for await (const event of transport.stream(request)) events.push(event);
  return events;
};
function fixture(produce) {
  const seen={creates:0,tools:0,results:0};
  const sdk={JsonlLocalAgentStore:class{},Agent:{create:async options=>{
    seen.creates++;
    return {send:async()=>({
      stream:()=>produce(options,seen),wait:async()=>({status:'finished'}),
    }),async [Symbol.asyncDispose](){}};
  }}};
  const transport=new CursorTransport({loadSDK:async()=>sdk,timeoutMs});
  const request={apiKey:'fixture',sessionId:'s',model:{id:'m'},messages:[user('work')],prompt:'work',
    tools:[{name:'work',parameters:{}}],validate:()=>true};
  return {transport,request,seen};
}
async function pending(transport,request) {
  const events=await read(transport,request),call=events.find(e=>e.type==='tool-call');
  assert.ok(call);
  return {...request,continuation:events.find(e=>e.type==='continuation').token,
    messages:[...request.messages,{role:'assistant',content:[call]},
      {role:'tool',toolCallId:call.id,content:[{type:'text',text:'completed once'}]}]};
}
const answer={type:'assistant',message:{content:[{type:'text',text:'done'}]}};

test('cancellation before asynchronous acquisition finishes never starts an SDK agent',async()=>{
  const {transport,request,seen}=fixture(async function*(){yield answer;});
  const controller=new AbortController();
  const acquire=transport.acquire.bind(transport);
  transport.acquire=async input=>{await Promise.resolve();controller.abort();return acquire(input);};
  try {
    await assert.rejects(read(transport,{...request,signal:controller.signal}),{code:'ABORTED'});
    assert.equal(seen.creates,0);
  } finally {await transport.close();}
});

test('cancellation during SDK loading prevents creation before the SDK is ready',async()=>{
  const {transport,request,seen}=fixture(async function*(){yield answer;});
  const controller=new AbortController();
  const load=transport.loadSDK;
  transport.loadSDK=async()=>{controller.abort();return load();};
  try {
    await assert.rejects(read(transport,{...request,signal:controller.signal}),{code:'ABORTED'});
    assert.equal(seen.creates,0);
  } finally {await transport.close();}
});

test('SDK progress can exceed the former total deadline without visible output',async()=>{
  const {transport,request}=fixture(async function*(){
    for(let i=0;i<5;i++){await delay(60);yield {type:'status'};}
    yield answer;
  });
  try {
    const events=await read(transport,request);
    assert.ok(events.some(e=>e.type==='text'&&e.text==='done'));
  } finally {await transport.close();}
});

test('long host tools pause SDK inactivity and their results are submitted exactly once',async()=>{
  const {transport,request,seen}=fixture(async function*(options){
    seen.tools++;
    await options.local.customTools.work.execute({},{toolCallId:'one'});
    seen.results++;
    yield answer;
  });
  try {
    const next=await pending(transport,request);
    await delay(timeoutMs*2);
    assert.ok(transport.continuations.has(next.continuation));
    const events=await read(transport,next);
    assert.ok(events.some(e=>e.type==='text'));
    assert.deepEqual(seen,{creates:1,tools:1,results:1});
  } finally {await transport.close();}
});

test('stalled SDK continuation reports a terminal timeout and a duplicate retains that cause',async()=>{
  const {transport,request,seen}=fixture(async function*(options){
    seen.tools++;
    await options.local.customTools.work.execute({},{toolCallId:'one'});
    seen.results++;
    await delay(timeoutMs*2);
    yield answer;
  });
  try {
    const next=await pending(transport,request);
    await assert.rejects(read(transport,next),{code:'CONTINUATION_TIMEOUT'});
    await assert.rejects(read(transport,next),{code:'CONTINUATION_TIMEOUT'});
    const changed={...next,messages:[...next.messages,user('changed')]};
    await assert.rejects(read(transport,changed),{code:'CONTINUATION_IDENTITY_MISMATCH'});
    assert.deepEqual(seen,{creates:1,tools:1,results:1});
  } finally {await transport.close();}
});

test('network failure after result submission cannot trigger replay of the same tool',async()=>{
  const {transport,request,seen}=fixture(async function*(options){
    seen.tools++;
    await options.local.customTools.work.execute({},{toolCallId:'one'});
    seen.results++;
    throw new ProviderError('CURSOR_CONNECTION_LOST','fixture disconnect');
  });
  try {
    const next=await pending(transport,request);
    for(let i=0;i<2;i++)await assert.rejects(read(transport,next),error=>
      error.code==='CONTINUATION_FAILED'&&error.message.includes('CURSOR_CONNECTION_LOST'));
    assert.deepEqual(seen,{creates:1,tools:1,results:1});
  } finally {await transport.close();}
});

test('genuine SDK inactivity without a tool still times out',async()=>{
  const {transport,request}=fixture(async function*(){await delay(timeoutMs*2);yield answer;});
  try {await assert.rejects(read(transport,request),{code:'TIMEOUT'});}
  finally {await transport.close();}
});

test('duplicate submission while SDK is active is rejected without a second tool execution',async()=>{
  const {transport,request,seen}=fixture(async function*(options){
    seen.tools++;
    await options.local.customTools.work.execute({},{toolCallId:'one'});
    seen.results++;
    await delay(60);
    yield answer;
  });
  try {
    const next=await pending(transport,request);
    const running=read(transport,next);
    await delay(10);
    await assert.rejects(read(transport,next),{code:'CONTINUATION_BUSY'});
    await running;
    assert.deepEqual(seen,{creates:1,tools:1,results:1});
  } finally {await transport.close();}
});

test('multiple tool handoffs in one SDK run can exceed the old total limit',async()=>{
  const {transport,request,seen}=fixture(async function*(options){
    for(let i=0;i<4;i++){
      await delay(60);
      seen.tools++;
      await options.local.customTools.work.execute({i},{toolCallId:'call-'+i});
      seen.results++;
    }
    yield answer;
  });
  try {
    let next=request;
    for(let i=0;i<4;i++){
      const events=await read(transport,next),call=events.find(e=>e.type==='tool-call');
      assert.ok(call);
      next={...request,continuation:events.find(e=>e.type==='continuation').token,
        messages:[...next.messages,{role:'assistant',content:[call]},
          {role:'tool',toolCallId:call.id,content:[{type:'text',text:'done'}]}]};
    }
    const final=await read(transport,next);
    assert.ok(final.some(e=>e.type==='text'));
    assert.deepEqual(seen,{creates:1,tools:4,results:4});
  } finally {await transport.close();}
});

test('proxy diagnosis tracks the route independently of the SDK retry policy',async()=>{
  const optionsSeen=[];
  const routes=[];
  const loadSDK=async()=>({JsonlLocalAgentStore:class{},Agent:{create:async options=>{
    optionsSeen.push(options.local.enableAgentRetries);
    return {send:async()=>({
      async *stream(){yield answer;},wait:async()=>({status:'finished'}),
    }),async [Symbol.asyncDispose](){}};
  }}});
  const requestDiagnostics={run(_id,route,action){routes.push(route);return action();}};
  const networkScope=action=>action();
  const request={apiKey:'fixture',sessionId:'s',model:{id:'m'},messages:[user('work')],prompt:'work'};
  const proxy=new CursorTransport({loadSDK,requestDiagnostics,networkScope});
  const optedIn=new CursorTransport({loadSDK,requestDiagnostics,networkScope,enableAgentRetries:true});
  const direct=new CursorTransport({loadSDK,requestDiagnostics});
  try {
    await read(proxy,request);
    await read(proxy,{...request,purpose:'compaction'});
    await read(optedIn,request);
    await read(direct,{...request,purpose:'compaction'});
    assert.deepEqual(optionsSeen,[false,true,true,false]);
    assert.deepEqual(routes,['proxy','proxy','proxy','direct']);
  } finally {await Promise.all([proxy.close(),optedIn.close(),direct.close()]);}
});
