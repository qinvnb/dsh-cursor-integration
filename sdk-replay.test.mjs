import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeBridge} from './src/native.js';
import {CursorTransport} from './src/transport.js';
const tool={name:'ask_user_question',parameters:{type:'object'}};
const history=(call,isError=false)=>[
 {role:'assistant',content:[call]},
 {role:'tool',toolCallId:call.id,content:[{type:'text',text:'answered once'}],isError}
];
test('repeated SDK delivery shares pending question and completed answer, including across sends',async()=>{
 const calls=[];const b=new NativeBridge([tool],()=>true,e=>calls.push(e));
 const execute=(args,id)=>b.customTools.ask_user_question.execute(args,{toolCallId:id});
 const first=execute({a:1,b:2},'sdk-1');
 assert.equal(execute({b:2,a:1},'sdk-1'),first);
 assert.equal(calls.length,1);
 b.resume(history(calls[0]));
 const answer=await first;
 b.beginRun();
 assert.equal(await execute({a:1,b:2},'sdk-1'),answer);
 assert.equal(calls.length,1);
 const next=execute({a:1,b:2},'sdk-2');assert.equal(calls.length,2);
 b.resume(history(calls[1],true));
 assert.equal((await next).isError,true);
 assert.equal((await execute({b:2,a:1},'sdk-2')).isError,true);
 await assert.rejects(execute({a:99},'sdk-1'),{code:'TOOL_CALL_ID_CONFLICT'});
 b.close();assert.equal(b.sdkCalls.size,0);
 await assert.rejects(execute({a:1},'sdk-3'),{code:'ABORTED'});
});
test('calls without SDK IDs remain independent and cancellation settles both duplicate waiters',async()=>{
 const events=[];const b=new NativeBridge([tool],()=>true,e=>events.push(e));
 const execute=id=>b.customTools.ask_user_question.execute({},{toolCallId:id});
 const a=execute(),c=execute();assert.equal(events.length,2);
 const one=execute('same'),two=execute('same');assert.equal(one,two);
 const settled=Promise.allSettled([a,c,one,two]);b.close();
 assert.ok((await settled).every(r=>r.status==='rejected'));
});
test('SDK retries a question before and after the answer; DSH executes it once through normal transport continuation',async()=>{
 let executes=0;const sdk={JsonlLocalAgentStore:class{},Agent:{create:async o=>({
  async send(){return {
   async *stream(){
    const execute=o.local.customTools.ask_user_question.execute;
    const first=execute({question:'choose'},{toolCallId:'sdk-repeat'});
    const parallel=execute({question:'choose'},{toolCallId:'sdk-repeat'});
    const [a,b]=await Promise.all([first,parallel]);
    const again=await execute({question:'choose'},{toolCallId:'sdk-repeat'});
    assert.deepEqual(a,b);assert.deepEqual(a,again);
    yield {type:'assistant',message:{content:[{type:'text',text:'choice received'}]}};
   },wait:async()=>({status:'finished'})
  }},async [Symbol.asyncDispose](){}
 })}};
 const t=new CursorTransport({loadSDK:async()=>sdk,timeoutMs:2000});
 const request={apiKey:'fixture',model:{id:'test'},prompt:'choose',messages:[{role:'user',content:[{type:'text',text:'choose'}]}],tools:[tool],validate:()=>true};
 try{
  const first=[];for await(const e of t.stream(request))first.push(e);
  const call=first.find(e=>e.type==='tool-call');assert.equal(first.filter(e=>e.type==='tool-call').length,1);
  executes++;
  const result=[];for await(const e of t.stream({...request,continuation:first.find(e=>e.type==='continuation').token,messages:[...request.messages,...history(call)]}))result.push(e);
  assert.equal(executes,1);assert.ok(!result.some(e=>e.type==='tool-call'));
  assert.equal(result.find(e=>e.type==='text').text,'choice received');
 }finally{await t.close();}
});
