import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeBridge} from './src/native.js';
import {buildCursorPrompt,compactRuntimeContext,latestRuntimeContext} from './src/request-context.js';
import {defineAdapter} from './src/adapter.js';
import {CursorTransport} from './src/transport.js';

const user=text=>({role:'user',content:[{type:'text',text}]});
const snapshot=(kind,text)=>({...user(text),source:{kind,form:'snapshot'}});
const assistant=text=>({role:'assistant',content:[{type:'text',text}]});
const runtime=snapshot('runtime-context','remote cwd /home/project');
const time=text=>snapshot('time-context',text);
const resultHistory=call=>[{role:'assistant',content:[{type:'tool-call',id:call.id,name:call.name,arguments:call.arguments}]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:'completed once'}]}];

test('72 historical snapshots collapse to the latest per kind without removing ordinary messages',()=>{
 const messages=[user('old user'),...Array.from({length:71},(_,i)=>time('old '+i)),runtime,time('now'),assistant('old answer'),user('live user')];
 const compact=compactRuntimeContext(messages);
 assert.equal(compact.length,5);assert.equal(latestRuntimeContext(compact).length,2);
 assert.deepEqual(compact.filter(m=>!m.source).map(m=>m.content[0].text),['old user','old answer','live user']);
 const repeated=time('same object');assert.equal(compactRuntimeContext([repeated,repeated]).length,1);
});

test('latest user corrections are separate from old plans and host replay metadata is absent from SDK prompt',()=>{
 const old={...assistant('OLD PLAN: build navigation'),source:{replayState:{response:{continuation:'HOST_ONLY_TOKEN'}}}};
 const prompt=buildCursorPrompt({messages:[user('build navigation'),old,runtime,user('Stop old task; answer my new question')],system:'This session runs in a Remote SSH workspace.',remote:true});
 const [reference,current]=prompt.split('Latest user request —');
 assert.match(reference,/OLD PLAN/);assert.ok(!reference.includes('Stop old task;'));
 assert.match(current,/Stop old task; answer my new question/);assert.ok(!prompt.includes('HOST_ONLY_TOKEN'));
 assert.match(prompt,/not accessible/);assert.match(prompt,/remote SSH Linux/);
 const continuing=buildCursorPrompt({messages:[user('old request'),old,{role:'tool',toolCallId:'x',content:[]}]});
 assert.match(continuing,/No new user request/);
});

test('runtime snapshots are seeded, unchanged snapshots are not resent and updates appear only once per batch',async()=>{
 const events=[];const bridge=new NativeBridge([{name:'read',parameters:{} }],()=>true,e=>events.push(e));
 bridge.rememberRuntimeContext([runtime,time('old')]);
 const first=bridge.customTools.read.execute({});const a=events.at(-1);bridge.resume([runtime,time('old'),...resultHistory(a)],[a.id]);
 assert.equal((await first).content.length,1);
 const second=bridge.customTools.read.execute({});const b=events.at(-1);
 const third=bridge.customTools.read.execute({});const c=events.at(-1);
 const batch=[runtime,time('old'),{role:'assistant',content:[b,c].map(call=>({type:'tool-call',id:call.id,name:call.name,arguments:call.arguments}))},
   ...[b,c].map(call=>({role:'tool',toolCallId:call.id,content:[{type:'text',text:'done'}]})),time('new')];
 // Validation must stay pure when transport checks it before resume.
 bridge.results(batch,[b.id,c.id]);bridge.results(batch,[b.id,c.id]);bridge.resume(batch,[b.id,c.id]);
 const results=await Promise.all([second,third]);assert.equal(results[0].content.length,2);assert.equal(results[1].content.length,1);
 assert.ok(!results[0].content[1].text.includes('remote cwd'));assert.match(results[0].content[1].text,/new/);assert.ok(!results[0].content[1].text.includes('old'));
 const fourth=bridge.customTools.read.execute({});const d=events.at(-1);bridge.resume([runtime,time('new'),...resultHistory(d)],[d.id]);assert.equal((await fourth).content.length,1);
 bridge.close();
});

test('a failed result match cannot consume a pending environment update',async()=>{
 let call;const bridge=new NativeBridge([{name:'read',parameters:{}}],()=>true,e=>{call=e;});
 bridge.rememberRuntimeContext([time('old')]);const pending=bridge.customTools.read.execute({});
 const correct=[time('new'),...resultHistory(call)];
 assert.throws(()=>bridge.resume([time('new'),correct[1]],[call.id]),{code:'TOOL_RESULT_MISMATCH'});
 bridge.resume(correct,[call.id]);assert.match((await pending).content[1].text,/new/);bridge.close();
});

function sdkFixture(){
 const capture={creates:0,sends:[],calls:0};
 capture.sdk={JsonlLocalAgentStore:class{},Agent:{create:async options=>{capture.creates++;capture.options=options;return {
  send:async prompt=>{capture.sends.push(prompt);return {supports:()=>false,status:'running',async *stream(){
    yield {type:'status',status:'RUNNING'};
    yield {type:'thinking',text:'working'};
    yield {type:'assistant',message:{content:[{type:'text',text:'answer '+capture.sends.length}]}};
  },wait:async()=>({status:'finished'})};},[Symbol.asyncDispose]:async()=>{},
 };}}};return capture;
}

test('new user input reuses a compatible SDK conversation even when a time snapshot changes',async()=>{
 const f=sdkFixture(),transport=new CursorTransport({loadSDK:async()=>f.sdk,timeoutMs:5000});
 const initial=[runtime,time('old'),user('first task')];
 const request={apiKey:'fake',model:{id:'test'},sessionId:'one',messages:initial,prompt:buildCursorPrompt({messages:initial}),tools:[],validate:()=>true};
 try {
  const first=[];for await(const e of transport.stream(request))first.push(e);
  const after=[runtime,time('new'),user('first task'),{role:'assistant',content:[{type:'reasoning',text:'working'},{type:'text',text:'answer 1'}]},user('new task, not the old one')];
  for await(const e of transport.stream({...request,messages:after,prompt:'FULL HISTORY SHOULD NOT BE USED'})){}
  assert.equal(f.creates,1);assert.equal(f.sends.length,2);assert.match(f.sends[1],/new task, not the old one/);
  assert.ok(!f.sends[1].includes('first task'));assert.ok(!f.sends[1].includes('FULL HISTORY'));
  assert.equal(transport.replaceSystemPrompt,false);
  const timing=first.filter(e=>e.type==='timing');for(const name of ['sdkLoadMs','sdkCreateMs','sdkSendMs','firstSDKEventMs','firstContentMs'])assert.ok(timing.some(e=>e.stage===name&&e.ms>=0));
 } finally {await transport.close();}
});

test('rewritten history creates a fresh SDK agent instead of silently retaining incompatible history',async()=>{
 const f=sdkFixture(),transport=new CursorTransport({loadSDK:async()=>f.sdk,timeoutMs:5000});
 const base={apiKey:'fake',model:{id:'test'},sessionId:'same',prompt:'initial',messages:[user('old')],tools:[]};
 try {for await(const e of transport.stream(base)){}
  for await(const e of transport.stream({...base,prompt:'rebuilt',messages:[user('rewritten summary'),user('latest')]})){}
  assert.equal(f.creates,2);assert.equal(f.sends[1],'rebuilt');
 } finally {await transport.close();}
});

test('adapter sends latest text and images with preserved ownership and reports timings without secrets',async()=>{
 let request;const Adapter=defineAdapter({LlmAdapter:class{},credential:async()=>'PRIVATE_KEY',profile:()=>({}),transport:{
  catalog:async()=>[{id:'test',parameters:[],variants:[]}],async *stream(value){request=value;yield {type:'text',text:'OK'};yield {type:'timing',stage:'sdkSendMs',ms:7};}
 },attachments:()=>({readImage:async()=>({data:Buffer.from('image')})})});
 const messages=[time('old'),runtime,time('new'),assistant('old plan'),{role:'user',content:[{type:'text',text:'NEW USER REQUEST'},{type:'image',attachment:{attachmentId:'x',mediaType:'image/png',width:1,height:1}}]}];
 const events=[];for await(const e of new Adapter().stream({model:'test',messages,system:'This session runs in a Remote SSH workspace.'}))events.push(e);
 assert.equal(request.prompt.images.length,1);assert.match(request.prompt.text,/NEW USER REQUEST/);assert.match(request.prompt.text,/sdkImage/);assert.ok(!request.prompt.text.includes('HOST_ONLY_TOKEN'));
 assert.equal(request.messages.filter(m=>m.source?.kind==='time-context').length,1);
 const finish=events.find(e=>e.type==='finish'),timings=finish.replayState.response.attempts[0].timings;
 assert.equal(timings.transport.sdkSendMs,7);assert.ok(timings.catalogMs>=0);assert.ok(!JSON.stringify(finish).includes('PRIVATE_KEY'));
});

test('cancellation while waiting for the first SDK output still cancels and disposes the run',async()=>{
 let release,cancelled=0,disposed=0;const controller=new AbortController();
 const sdk={JsonlLocalAgentStore:class{},Agent:{create:async()=>({
  send:async()=>({status:'running',supports:()=>true,cancel:async()=>{cancelled++;release?.();},
    async *stream(){await new Promise(resolve=>{release=resolve;});},wait:async()=>({status:'cancelled'})}),
  [Symbol.asyncDispose]:async()=>{disposed++;},
 })}};
 const transport=new CursorTransport({loadSDK:async()=>sdk,timeoutMs:5000});
 try {
  await assert.rejects(async()=>{for await(const e of transport.stream({apiKey:'fake',model:{id:'test'},messages:[user('latest')],prompt:'latest',signal:controller.signal})){
    if(e.type==='timing'&&e.stage==='sdkSendMs')controller.abort();
  }});
  assert.equal(cancelled,1);assert.equal(disposed,1);
 } finally {await transport.close();}
});
import {isRemoteContext as detectSsh} from './src/request-context.js';
test('SSH workspace is recognized from the latest host-owned working directory',()=>{
  const remote = {role:'user',source:{kind:'runtime-context',form:'snapshot',sections:[{name:'working-directory:current',text:'Current working directory: '+JSON.stringify('C:/Users/tester/.dsh/remote-ssh/workspaces/44ff7cf3-2c8b-4813-b861-9bad274c8d72'.replaceAll('/','\\'))}]}};
  assert.equal(detectSsh('',[remote]),true);
  assert.equal(detectSsh('',[{...remote,source:{kind:'user'}}]),false);
  assert.equal(detectSsh('',[remote,{...remote,source:{...remote.source,sections:[]}}]),false);
});
