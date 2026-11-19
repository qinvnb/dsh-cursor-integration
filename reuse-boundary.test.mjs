import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CursorTransport} from './src/transport.js';
import {buildCursorPrompt} from './src/request-context.js';
const msg=(role,text)=>({role,content:[{type:'text',text}]});
const image={role:'user',content:[{type:'image',attachment:{attachmentId:'fixture'}}]};
function fixture(root){
 const seen={creates:0,resumes:0,prompts:[],paths:[]};
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>{
  const id='agent-'+(++seen.creates);return {agentId:id,send:async prompt=>{
   seen.prompts.push(prompt);return {async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}};},wait:async()=>({status:'finished'})};
  },async [Symbol.asyncDispose](){}};
 },resume:async()=>{seen.resumes++;throw Error('old checkpoint must not be resumed');}}};
 const transport=()=>new CursorTransport({checkpointRoot:root,loadSDK:async()=>sdk,onPath:(_id,text)=>seen.paths.push(text)});
 const request={apiKey:'fixture',sessionId:'s',model:{id:'m'},tools:[],validate:()=>true};
 const run=async(t,messages,extra={})=>{for await(const e of t.stream({...request,messages,prompt:()=>buildCursorPrompt({messages}),...extra}))void e;};
 return {seen,transport,run};
}
test('historical image permits text-only follow-up reuse; a new image still rebuilds',async()=>{
 const f=fixture(),t=f.transport();
 try{
  await f.run(t,[image]);const history=[image,msg('assistant','answer'),msg('user','new text')];
  await f.run(t,history);assert.equal(f.seen.creates,1);assert.ok(!f.seen.prompts[1].includes('attachmentId'));
  await f.run(t,[...history,msg('assistant','answer'),image]);assert.equal(f.seen.creates,2);
  assert.ok(f.seen.paths.some(s=>s.includes('新增消息含图片')));
 }finally{await t.close();}
});
for(const restart of [false,true])test('summary replacement rejects old '+(restart?'disk checkpoint':'idle agent')+' and sends only retained history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'summary-boundary-'));const f=fixture(root);let t=f.transport();
 try{
  await f.run(t,[msg('user','OLD_HISTORY_MUST_NOT_RETURN')]);
  if(restart){await t.close();t=f.transport();}
  await f.run(t,[msg('user','SUMMARY_ONLY'),msg('user','latest question')]);
  assert.equal(f.seen.creates,2);assert.equal(f.seen.resumes,0);
  assert.match(f.seen.prompts.at(-1),/SUMMARY_ONLY/);assert.ok(!f.seen.prompts.at(-1).includes('OLD_HISTORY'));
 }finally{await t.close();await rm(root,{recursive:true,force:true});}
});
test('credential and model changes continue to force separate agents',async()=>{
 const f=fixture(),t=f.transport();
 try{
  const first=[msg('user','one')];await f.run(t,first);
  const next=[...first,msg('assistant','answer'),msg('user','two')];await f.run(t,next,{apiKey:'other'});
  await f.run(t,[...next,msg('assistant','answer'),msg('user','three')],{apiKey:'other',model:{id:'different'}});
  assert.equal(f.seen.creates,3);assert.ok(f.seen.paths.some(s=>s.includes('账号、模型')));
 }finally{await t.close();}
});
