import assert from 'node:assert/strict';
import test from 'node:test';
import {LlmAdapter,LlmError} from '@deepseek-ai/dsh-llm';
import {defineAdapter} from './src/adapter.js';
import {ProviderError} from './src/provider.js';

const user=text=>({role:'user',content:[{type:'text',text}]});
const catalog=[{id:'claude',displayName:'Claude',parameters:[]}];
const collect=async iter=>{
  const out=[];
  for await (const item of iter) out.push(item);
  return out;
};

function setup(streamFn,extra={}){
  const reported=[];
  const failovers=[];
  let routeCalls=0;
  const Adapter=defineAdapter({
    LlmAdapter,LlmError,
    profile:()=>({models:['claude']}),
    credential:async()=>'fallback-key',
    routeAccount:async()=>{routeCalls++;return {ref:'acct-a',key:'key-a',models:catalog};},
    reportAccountFailure:(ref,code)=>reported.push({ref,code}),
    failoverAccount:async(_model,_sig,skip)=>{
      failovers.push([...skip]);
      return skip.has('acct-a')&&!extra.noAlt?{ref:'acct-b',key:'key-b',models:catalog}:undefined;
    },
    preferredRoute:()=>'proxy',
    transport:{lazyPrompt:false,catalog:async()=>catalog,stream:streamFn},
    retryDelayMs:0,
    ...extra,
  });
  return {adapter:new Adapter(),reported,failovers,routeCalls:()=>routeCalls};
}

test('Step-1 rate limit cools down account A, fails over to account B, and records both attempts',async()=>{
  const seenKeys=[];
  const {adapter,reported,failovers}=setup(async function*(req){
    seenKeys.push(req.apiKey);
    if(req.apiKey==='key-a') throw new ProviderError('CURSOR_RATE_LIMITED','rate limited');
    yield {type:'text',text:'ok from b'};
  });
  const events=await collect(adapter.stream({model:'claude',messages:[user('hi')],sessionId:'s1'}));
  assert.deepEqual(seenKeys,['key-a','key-b']);
  assert.deepEqual(reported,[{ref:'acct-a',code:'CURSOR_RATE_LIMITED'}]);
  assert.deepEqual(failovers,[['acct-a']]);
  const finish=events.find(e=>e.type==='finish');
  assert.equal(finish.reason.kind,'stop');
  assert.equal(finish.replayState.response.accountRef,'acct-b');
  assert.equal(finish.replayState.response.attempts.length,2);
  assert.equal(finish.replayState.response.attempts[0].accountRef,'acct-a');
  assert.equal(finish.replayState.response.attempts[1].accountRef,'acct-b');
});

test('Step-1 transient service failure retries once before any output and succeeds',async()=>{
  let calls=0;
  const {adapter,failovers}=setup(async function*(){
    if(++calls===1) throw new ProviderError('CURSOR_SERVICE_FAILED','temporary 503');
    yield {type:'text',text:'recovered'};
  });
  const events=await collect(adapter.stream({model:'claude',messages:[user('hi')],sessionId:'s2'}));
  assert.equal(calls,2);
  assert.deepEqual(failovers,[]);
  const finish=events.find(e=>e.type==='finish');
  assert.equal(finish.reason.kind,'stop');
  assert.equal(finish.replayState.response.attempts.length,2);
});

test('failures after visible output, during tool continuation, or after CURSOR_RETRY_EXHAUSTED never retry',async()=>{
  let afterOutputCalls=0;
  const afterOutput=setup(async function*(){
    afterOutputCalls++;
    yield {type:'text',text:'partial'};
    throw new ProviderError('CURSOR_SERVICE_FAILED','mid-stream drop');
  });
  const outEvents=await collect(afterOutput.adapter.stream({model:'claude',messages:[user('hi')],sessionId:'s3'}));
  assert.equal(afterOutputCalls,1);
  const outFailure=outEvents.find(e=>e.type==='finish').reason.failure;
  assert.equal(outFailure.code,'SERVER');
  assert.match(outFailure.message,/CURSOR_SERVICE_FAILED/);

  let contCalls=0;
  const cont=setup(async function*(){
    contCalls++;
    throw new ProviderError('CONTINUATION_FAILED','wrapped rate limit',['rate_limited'],'CURSOR_RATE_LIMITED');
  });
  const contMessages=[
    user('hi'),
    {role:'assistant',content:[{type:'tool-call',id:'t1',name:'bash',arguments:'{}'}],
      source:{replayState:{response:{protocol:'cursor-native-v1',continuation:'tok-1',accountRef:'acct-a',networkRoute:'proxy'}}}},
    {role:'tool',toolCallId:'t1',content:[{type:'text',text:'done'}]},
  ];
  const contEvents=await collect(cont.adapter.stream({model:'claude',messages:contMessages,sessionId:'s4'}));
  assert.equal(contCalls,1);
  assert.deepEqual(cont.failovers,[]);
  assert.deepEqual(cont.reported,[{ref:'acct-a',code:'CURSOR_RATE_LIMITED'}]);
  const contFailure=contEvents.find(e=>e.type==='finish').reason.failure;
  assert.equal(contFailure.code,'RATE_LIMIT');
  assert.match(contFailure.message,/CONTINUATION_FAILED/);

  let exhaustedCalls=0;
  const exhausted=setup(async function*(){
    exhaustedCalls++;
    throw new ProviderError('CURSOR_RETRY_EXHAUSTED','budget exhausted');
  });
  const exEvents=await collect(exhausted.adapter.stream({model:'claude',messages:[user('hi')],sessionId:'s5'}));
  assert.equal(exhaustedCalls,1);
  const exFailure=exEvents.find(e=>e.type==='finish').reason.failure;
  assert.equal(exFailure.code,'STREAM_CLOSED');
  assert.match(exFailure.message,/CURSOR_RETRY_EXHAUSTED/);
});

test('adapter disables DSH automatic retries and keeps non-recoverable failures out of continuation whitelist',async()=>{
  const nonContinuable=['CURSOR_AUTH_FAILED','CURSOR_CONTEXT_TOO_LONG','INVALID_ARGUMENTS'];
  for (const code of nonContinuable) {
    const {adapter}=setup(async function*(){
      throw new ProviderError(code,'terminal error');
    });
    assert.deepEqual(adapter.providerRetryPolicy().maxRetries,0);
    const events=await collect(adapter.stream({model:'claude',messages:[user('hi')],sessionId:'nc-'+code}));
    assert.equal(events.find(e=>e.type==='finish').reason.failure.code,code);
  }
  const contInvalid=setup(async function*(){
    throw new ProviderError('CONTINUATION_FAILED','invalid args',[],'INVALID_ARGUMENTS');
  });
  const contInvalidEvents=await collect(contInvalid.adapter.stream({model:'claude',messages:[user('hi')],sessionId:'nc-cont'}));
  assert.equal(contInvalidEvents.find(e=>e.type==='finish').reason.failure.code,'CONTINUATION_FAILED');
});

test('empty DSH retry trigger unpins failed continuation without replaying tools and preserves Step-1 prompt',async()=>{
  const seen=[];
  const Adapter=defineAdapter({
    LlmAdapter,LlmError,
    profile:()=>({models:['claude']}),
    credential:async()=>'fallback-key',
    routeAccount:async(_model,_sig,pinned)=>pinned?{ref:pinned,key:'key-a',models:catalog}:{ref:'acct-b',key:'key-b',models:catalog},
    preferredRoute:()=>'proxy',
    transport:{lazyPrompt:false,catalog:async()=>catalog,stream:async function*(req){seen.push(req);yield {type:'text',text:'resumed'};}},
    retryDelayMs:0,
  });
  const adapter=new Adapter();

  const retryMarker={role:'user',content:[],source:{kind:'retry'}};
  const contMessages=[
    user('run bash'),
    {role:'assistant',content:[{type:'tool-call',id:'t1',name:'bash',arguments:'{}'}],
      source:{replayState:{response:{protocol:'cursor-native-v1',continuation:'dead-tok',accountRef:'acct-a',networkRoute:'proxy'}}}},
    {role:'tool',toolCallId:'t1',content:[{type:'text',text:'tool output'}]},
    retryMarker,
  ];
  await collect(adapter.stream({model:'claude',messages:contMessages,sessionId:'s-cont-retry'}));
  assert.equal(seen[0].continuation,undefined);
  assert.equal(seen[0].apiKey,'key-b');
  assert.match(seen[0].prompt,/No new user request is present/);

  await collect(adapter.stream({model:'claude',messages:[user('explain foo'),retryMarker],sessionId:'s-step1-retry'}));
  assert.match(seen[1].prompt,/explain foo/);
  assert.doesNotMatch(seen[1].prompt,/No new user request/);
});
