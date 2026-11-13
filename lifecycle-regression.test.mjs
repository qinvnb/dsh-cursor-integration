import test from 'node:test';
import assert from 'node:assert/strict';
import {removeDirectory} from './src/checkpoints.js';
import {CursorTransport} from './src/transport.js';

test('Windows directory cleanup failure is deferred without replacing the turn error',async()=>{
 const reports=[];
 const result=await removeDirectory('fixture',code=>reports.push(code),async(_path,options)=>{
   assert.equal(options.maxRetries,3);assert.equal(options.retryDelay,100);
   throw Object.assign(new Error('directory busy'),{code:'ENOTEMPTY'});
 });
 assert.equal(result,false);assert.deepEqual(reports,['ENOTEMPTY']);
 assert.equal(await removeDirectory('fixture',()=>{throw Error('observer');},async()=>{throw Error('cleanup');}),false);
});

test('a prior completed turn expiry cannot remove a later long-running tool continuation',async t=>{
 const original=setTimeout,callbacks=new Map();
 t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>{
   const timer=original(fn,delay,...args);callbacks.set(timer,fn);return timer;
 });
 let sends=0;
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async options=>({
   send:async()=>{const n=++sends;return {
     async *stream(){await options.local.customTools.work.execute({n},{toolCallId:'sdk-'+n});yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}};},
     wait:async()=>({status:'finished'}),
   };},async [Symbol.asyncDispose](){},
 })}};
 const transport=new CursorTransport({loadSDK:async()=>sdk});
 const msg=(role,text)=>({role,content:[{type:'text',text}]});
 const request={apiKey:'fixture',sessionId:'s',model:{id:'m'},tools:[{name:'work',parameters:{}}],validate:()=>true,messages:[msg('user','first')],prompt:'first'};
 const read=async r=>{const rows=[];for await(const event of transport.stream(r))rows.push(event);return rows;};
 try {
   const first=await read(request),call=first.find(e=>e.type==='tool-call');
   const token=first.find(e=>e.type==='continuation').token;
   const history=[...request.messages,{role:'assistant',content:[call]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:'done'}]}];
   await read({...request,messages:history,continuation:token});
   const session=transport.idle.get('s');
   const oldExpiry=callbacks.get(session.recoveryTimer);
   const second=await read({...request,messages:[...history,msg('assistant','answer'),msg('user','second')]});
   const next=second.find(e=>e.type==='continuation').token;
   oldExpiry?.();
   assert.ok(transport.continuations.has(next),'an old timer must not expire the new tool result handoff');
 } finally {
   await transport.close();for(const timer of callbacks.keys())clearTimeout(timer);
 }
});
