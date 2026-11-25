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
  const directOptedIn=new CursorTransport({loadSDK,requestDiagnostics,enableAgentRetries:true});
  try {
    await read(proxy,request);
    await read(proxy,{...request,purpose:'compaction'});
    await read(optedIn,request);
    await read(direct,{...request,purpose:'compaction'});
    await read(directOptedIn,request);
    assert.deepEqual(optionsSeen,[false,true,true,false,true]);
    assert.deepEqual(routes,['proxy','proxy','proxy','direct','direct']);
  } finally {await Promise.all([proxy.close(),optedIn.close(),direct.close(),directOptedIn.close()]);}
});

test('run.wait failure after tool submission surfaces allowlisted facts without leaking raw text or replaying tools',async()=>{
  const seen={creates:0,tools:0,results:0};
  const sdk={JsonlLocalAgentStore:class{},Agent:{create:async options=>{
    seen.creates++;
    return {send:async()=>({
      stream:async function*(){
        seen.tools++;
        await options.local.customTools.work.execute({},{toolCallId:'one'});
        seen.results++;
      },
      wait:async()=>({status:'error',error:{message:'[deadline_exceeded] bidi_append_deadline_exceeded: confidential detail'}}),
    }),async [Symbol.asyncDispose](){}};
  }}};
  const transport=new CursorTransport({loadSDK:async()=>sdk,timeoutMs});
  const request={apiKey:'fixture',sessionId:'s',model:{id:'m'},messages:[user('work')],prompt:'work',
    tools:[{name:'work',parameters:{}}],validate:()=>true};
  try {
    const next=await pending(transport,request);
    await assert.rejects(read(transport,next),error=>{
      assert.equal(error.code,'CONTINUATION_FAILED');
      assert.match(error.message,/CURSOR_NETWORK_TIMEOUT: deadline_exceeded, bidi_append_deadline_exceeded/);
      assert.doesNotMatch(error.message,/confidential/);
      return true;
    });
    assert.deepEqual(seen,{creates:1,tools:1,results:1});
  } finally {await transport.close();}
});

test('retry budget guard aborts consecutive retries without progress and resets after visible progress',async()=>{
  let triggerRetry;
  const requestDiagnostics={run(_id,_route,action,_proto,hooks){triggerRetry=hooks?.onRetry;return action();}};
  const paths=[];
  const makeSdk=(produce)=>async()=>({JsonlLocalAgentStore:class{},Agent:{create:async()=>({
    send:async()=>({stream:produce,wait:async()=>({status:'finished'})}),
    async [Symbol.asyncDispose](){},
  })}});

  const tripped=new CursorTransport({
    loadSDK:makeSdk(async function*(){
      triggerRetry?.(1);
      triggerRetry?.(2);
      triggerRetry?.(3);
      await delay(200);
      yield answer;
    }),
    requestDiagnostics,enableAgentRetries:true,maxConsecutiveSdkRetries:2,maxRetryWindowMs:5000,timeoutMs:5000,
    onPath:(_id,label)=>paths.push(label),
  });
  try {
    await assert.rejects(read(tripped,{apiKey:'fixture',sessionId:'s1',model:{id:'m'},messages:[user('work')],prompt:'work'}),
      {code:'CURSOR_RETRY_EXHAUSTED'});
    assert.ok(paths.includes('连接波动，正在第 1 次自动重连…'));
    assert.ok(paths.includes('连接波动，正在第 3 次自动重连…'));
    assert.ok(paths.includes('自动重连超时止损'));
  } finally {await tripped.close();}

  const resetOnProgress=new CursorTransport({
    loadSDK:makeSdk(async function*(){
      triggerRetry?.(1);
      triggerRetry?.(2);
      yield {type:'thinking',text:'making progress'};
      triggerRetry?.(3);
      triggerRetry?.(4);
      yield answer;
    }),
    requestDiagnostics,enableAgentRetries:true,maxConsecutiveSdkRetries:2,maxRetryWindowMs:5000,timeoutMs:5000,
  });
  try {
    const events=await read(resetOnProgress,{apiKey:'fixture',sessionId:'s2',model:{id:'m'},messages:[user('work')],prompt:'work'});
    assert.ok(events.some(e=>e.type==='text'&&e.text==='done'));
  } finally {await resetOnProgress.close();}
});

test('retry budget window aborts stalled retries and protects completed tools from replay',async()=>{
  let triggerRetry;
  const requestDiagnostics={run(_id,_route,action,_proto,hooks){triggerRetry=hooks?.onRetry;return action();}};
  const windowTransport=new CursorTransport({
    loadSDK:async()=>({JsonlLocalAgentStore:class{},Agent:{create:async()=>({
      send:async()=>({
        stream:async function*(){triggerRetry?.(1);await delay(300);yield answer;},
        wait:async()=>({status:'finished'}),
      }),
      async [Symbol.asyncDispose](){},
    })}}),
    requestDiagnostics,enableAgentRetries:true,maxConsecutiveSdkRetries:3,maxRetryWindowMs:40,timeoutMs:5000,
  });
  try {
    await assert.rejects(read(windowTransport,{apiKey:'fixture',sessionId:'s3',model:{id:'m'},messages:[user('work')],prompt:'work'}),
      {code:'CURSOR_RETRY_EXHAUSTED'});
  } finally {await windowTransport.close();}

  const seen={creates:0,tools:0,results:0};
  const contTransport=new CursorTransport({
    loadSDK:async()=>({JsonlLocalAgentStore:class{},Agent:{create:async options=>{
      seen.creates++;
      return {send:async()=>({
        stream:async function*(){
          seen.tools++;
          await options.local.customTools.work.execute({},{toolCallId:'one'});
          seen.results++;
          triggerRetry?.(1);
          triggerRetry?.(2);
          await delay(300);
          yield answer;
        },
        wait:async()=>({status:'finished'}),
      }),async [Symbol.asyncDispose](){}};
    }}}),
    requestDiagnostics,enableAgentRetries:true,maxConsecutiveSdkRetries:1,maxRetryWindowMs:5000,timeoutMs:5000,
  });
  const req={apiKey:'fixture',sessionId:'s4',model:{id:'m'},messages:[user('work')],prompt:'work',
    tools:[{name:'work',parameters:{}}],validate:()=>true};
  try {
    const next=await pending(contTransport,req);
    await assert.rejects(read(contTransport,next),error=>
      error.code==='CONTINUATION_FAILED'&&error.message.includes('CURSOR_RETRY_EXHAUSTED: retry_budget_exceeded'));
    assert.deepEqual(seen,{creates:1,tools:1,results:1});
  } finally {await contTransport.close();}
});

test('HTTP 200 response headers pause the retry window timer while still bounding total consecutive retries',async()=>{
  let hooks;
  const requestDiagnostics={run(_id,_route,action,_proto,h){hooks=h;return action();}};
  const paths=[];
  const makeSdk=produce=>async()=>({JsonlLocalAgentStore:class{},Agent:{create:async()=>({
    send:async()=>({stream:produce,wait:async()=>({status:'finished'})}),
    async [Symbol.asyncDispose](){},
  })}});

  const healthyWait=new CursorTransport({
    loadSDK:makeSdk(async function*(){
      hooks?.onRetry?.(1);
      hooks?.onResponseHeaders?.(200,undefined);
      await delay(80);
      yield answer;
    }),
    requestDiagnostics,enableAgentRetries:true,maxConsecutiveSdkRetries:3,maxRetryWindowMs:35,timeoutMs:5000,
    onPath:(_id,label)=>paths.push(label),
  });
  try {
    const events=await read(healthyWait,{apiKey:'fixture',sessionId:'s-h200',model:{id:'m'},messages:[user('work')],prompt:'work'});
    assert.ok(events.some(e=>e.type==='text'&&e.text==='done'));
    assert.ok(paths.includes('已重新建立连接，等待模型响应…'));
  } finally {await healthyWait.close();}

  const resetLoop=new CursorTransport({
    loadSDK:makeSdk(async function*(){
      hooks?.onRetry?.(1);
      hooks?.onResponseHeaders?.(200,0);
      hooks?.onRetry?.(2);
      hooks?.onRetry?.(3);
      await delay(100);
      yield answer;
    }),
    requestDiagnostics,enableAgentRetries:true,maxConsecutiveSdkRetries:2,maxRetryWindowMs:5000,timeoutMs:5000,
  });
  try {
    await assert.rejects(read(resetLoop,{apiKey:'fixture',sessionId:'s-loop',model:{id:'m'},messages:[user('work')],prompt:'work'}),
      {code:'CURSOR_RETRY_EXHAUSTED'});
  } finally {await resetLoop.close();}
});
