import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CursorTransport} from './src/transport.js';
import {newDirectory,publish,claim,sweep} from './src/checkpoints.js';

const msg=(role,text)=>({role,content:[{type:'text',text}]});
test('restart resumes only the matching account and history, builds full prompts on demand',async t=>{
  const root=await mkdtemp(join(tmpdir(),'checkpoint-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let builds=0,creates=0,resumes=0;const sent=[];
  const agent={agentId:'test-agent',async send(prompt){sent.push(prompt);return {async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}};},wait:async()=>({status:'finished'})};},async [Symbol.asyncDispose](){}};
  const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>{creates++;return agent;},resume:async id=>{assert.equal(id,agent.agentId);resumes++;return agent;}}};
  async function run(messages,key){
    const transport=new CursorTransport({checkpointRoot:root,loadSDK:async()=>sdk});
    try{for await(const e of transport.stream({apiKey:key,sessionId:'s',model:{id:'test'},tools:[],messages,prompt:()=>{builds++;return 'full text';}}))void e;}finally{await transport.close();}
  }
  const history=[msg('user','old')];
  await run(history,'key1');
  history.push(msg('assistant','answer'),msg('user','latest question'));
  await run(history,'key1');
  assert.equal(resumes,1);assert.equal(builds,1);assert.match(sent[1],/latest question/);assert.ok(!sent[1].includes('"old"'));
  history.push(msg('assistant','answer'),msg('user','next'));
  await run(history,'key2');
  history[0]=msg('user','edited');
  await run(history,'key1');
  assert.equal(creates,3);assert.equal(builds,3);assert.equal(resumes,1);
});
test('only one reader claims a checkpoint and cleanup preserves its active lease',async t=>{
  const root=await mkdtemp(join(tmpdir(),'checkpoint-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=await newDirectory(root,'s');await publish(dir,{agentId:'a',committedLength:1});
  const results=await Promise.all([claim(root,'s',()=>true),claim(root,'s',()=>true)]);
  assert.equal(results.filter(Boolean).length,1);
  await sweep(root);assert.ok((await readdir(dir)).some(n=>n.startsWith('busy-')));
  await publish(dir,{agentId:'a',committedLength:1});
  const [marker]=await readdir(dir);await rename(join(dir,marker),join(dir,marker.replace(/^ready-\d+/,'ready-1')));
  await sweep(root);assert.equal((await readdir(root)).length,0);
});
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('completed turn survives process exit without transport.close, then resumes with only the follow-up',async t=>{
  const root=await mkdtemp(join(tmpdir(),'completed-at-exit-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=`
    import {CursorTransport} from './src/transport.js';
    const [root,phase]=process.argv.slice(1);
    const msg=(role,text)=>({role,content:[{type:'text',text}]});
    const agent={agentId:'agent-A',async send(prompt){
      if(phase==='resume' && (prompt.includes('original question')||!prompt.includes('follow-up')))throw Error('history replayed');
      return {async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}};},wait:async()=>({status:'finished'})};
    },async [Symbol.asyncDispose](){}};
    const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>{if(phase==='resume')throw Error('unexpected create');return agent;},resume:async id=>{if(id!==agent.agentId)throw Error('wrong id');return agent;}}};
    const t=new CursorTransport({loadSDK:async()=>sdk,checkpointRoot:root,onPath:(_,label)=>console.log(label)});
    const messages=[msg('user','original question')];if(phase==='resume')messages.push(msg('assistant','answer'),msg('user','follow-up'));
    for await(const e of t.stream({apiKey:'fixture',sessionId:'s',model:{id:'m'},messages,prompt:'original question'})){}
    process.exit(0);`;
  function run(phase){
    const r=spawnSync(process.execPath,['--input-type=module','-e',fixture,root,phase],{cwd:fileURLToPath(new URL('.',import.meta.url)),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return r.stdout;
  }
  run('create');
  await sweep(root);
  assert.match(run('resume'),/已从检查点恢复/);
});

test('a live idle agent owns its sealed state; a transient resume rejection preserves it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'resume-limit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const msg=(role,text)=>({role,content:[{type:'text',text}]});
  let creates=0,resumes=0;const labels=[];
  const agent={agentId:'a',async send(){return{async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}};},wait:async()=>({status:'finished'})}},async [Symbol.asyncDispose](){}};
  const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>{creates++;return agent;},resume:async()=>{if(++resumes===1)throw Object.assign(Error('private'),{name:'RateLimitError',status:429});return agent;}}};
  const transport=()=>new CursorTransport({loadSDK:async()=>sdk,checkpointRoot:root,onPath:(_,s)=>labels.push(s)});
  const messages=[msg('user','first')],request={apiKey:'k',sessionId:'s',model:{id:'m'},messages,prompt:'full'};
  const send=async t=>{for await(const e of t.stream(request))void e;};
  const first=transport();await send(first);assert.equal(await claim(root,'s',()=>true),undefined);await sweep(root);await first.close();
  messages.push(msg('assistant','answer'),msg('user','follow-up'));
  const second=transport();await assert.rejects(()=>send(second),{code:'CURSOR_RATE_LIMITED'});await second.close();
  const third=transport();await send(third);await third.close();
  assert.equal(creates,1);assert.equal(resumes,2);
  assert.ok(labels.includes('已从检查点恢复'));
});
