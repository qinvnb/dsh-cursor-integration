import test from 'node:test';
import assert from 'node:assert/strict';
import {installCursorContextMeter,createCursorContextRoute} from './src/context.js';
import {z} from 'zod';
import {Context,Service} from '@deepseek-ai/cordis';
import {isRemoteJsonValue} from '@deepseek-ai/dsh-typert-protocol';

const header=provider=>({config:{provider,model:'model'},tools:[]});
const sample=Object.freeze({baseline:{kind:'usage',tokens:4070000},totalTokens:4070000,surfaceTokens:120000,surfaceDeltaTokens:0,nodes:[],logRevision:10});

test('completed and resumed sessions expose lossless JSON to the DSH stream',()=>{
 const route=createCursorContextRoute(z);
 let state=route.init();
 const events=[
  {type:'request/header',data:{header:header('cursor')}},
  {type:'turn/start',time:100,data:{}},
  {type:'assistant/attempt',data:{stream:[{chunk:{type:'finish',replayState:{response:{accountRef:'account-a'}}}}]}},
  {type:'turn/end',time:200,data:{}},
  {type:'session/end-seed',time:300,data:{}},
 ];
 for(const event of events){
  state=route.apply(state,event);
  const value=route.wire.viewSchema.parse(route.wire.view(state));
  assert.ok(isRemoteJsonValue(value),event.type);
  assert.ok(z.record(z.string(),z.json()).safeParse({cursorContextRoute:value}).success,event.type);
 }
 assert.equal(state.started,null);
 assert.equal(state.accountRef,null);
 const restored=route.stateSchema.parse(JSON.parse(JSON.stringify(state)));
 assert.deepEqual(restored,state);
});

test('Cursor pressure uses current retained history, never cumulative billing; other routes retain identity',()=>{
 const meter={measure:()=>sample};const original=meter.measure;
 const dispose=installCursorContextMeter(meter,()=>2000);
 const cursor={requestHeader:()=>header('cursor')};
 const result=meter.measure(cursor);
 assert.equal(result.totalTokens,122000);assert.equal(result.baseline.kind,'estimated');
 assert.equal(sample.totalTokens,4070000);assert.equal(meter.measure({requestHeader:()=>header('other')}),sample);
 assert.equal(meter.measure(cursor,header('other')),sample);
 dispose();assert.equal(meter.measure,original);
});

test('compaction shrinks Cursor pressure and switching to Cursor uses destination header',()=>{
 let surface=120000;const meter={measure:()=>({...sample,surfaceTokens:surface})};
 installCursorContextMeter(meter,()=>2000);
 const session={requestHeader:()=>header('other')};
 assert.equal(meter.measure(session,header('cursor')).totalTokens,122000);
 surface=15000;assert.equal(meter.measure(session,header('cursor')).totalTokens,17000);
});

test('route projection can replay existing logs, resets capacity on model changes and keeps unknown capacity unknown',()=>{
 const route=createCursorContextRoute(z);let state=route.init();
 state=route.apply(state,{type:'request/header',data:{header:header('cursor')}});
 state=route.apply(state,{type:'request/context',data:{contextWindow:1000000}});
 assert.equal(route.wire.view(state).contextWindow,1000000);
 state=route.apply(state,{type:'request/header',data:{header:{config:{provider:'cursor',model:'different'}}}});
 assert.equal(state.contextWindow,null);assert.ok(route.stateSchema.safeParse(state).success);
});

test('scoped Cordis service wrapping is visible to other consumers and reverses on disposal',()=>{
 const ctx=new Context();class Meter extends Service{constructor(c){super(c,'tokenMeter');}measure(){return sample;}}
 new Meter(ctx);
 const original=ctx.tokenMeter.measure;
 const dispose=installCursorContextMeter(ctx.tokenMeter,()=>1000);
 assert.equal(ctx.extend().tokenMeter.measure({requestHeader:()=>header('cursor')}).totalTokens,121000);
 dispose();assert.equal(ctx.tokenMeter.measure({requestHeader:()=>header('cursor')}),sample);
});
import {createCompactionStatus} from './src/context.js';
test('compression status replays real summary and pruning events without mistaking pruning for a summary',()=>{
 const projection=createCompactionStatus(z);
 let state=projection.init();
 const apply=(type,time,data={})=>{
  state=projection.apply(state,{type,time,data});
  assert.ok(isRemoteJsonValue(projection.stateSchema.parse(state)));
 };
 apply('compaction/prune',10,{shadowedTokenCount:1234});
 assert.equal(state.status,'idle');assert.equal(state.summarized,null);
 apply('compaction/start',20,{compactionId:'a'});
 assert.equal(state.status,'running');
 apply('compaction/end',25,{compactionId:'b',error:'unrelated'});
 assert.equal(state.status,'running');
 apply('compaction/end',30,{compactionId:'a',error:'Cursor SDK does not expose temperature/maxTokens/stop controls'});
 assert.equal(state.status,'failed');assert.equal(state.error,'插件拒绝了压缩参数');
 apply('compaction/start',40,{compactionId:'c'});
 apply('compaction/summary',50,{compactionId:'c'});
 apply('compaction/end',51,{compactionId:'c'});
 assert.equal(state.status,'summarized');assert.equal(state.summarized,50);
 assert.equal(state.error,null);assert.equal(state.prunedTokens,1234);
 assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(state))),state);
});
