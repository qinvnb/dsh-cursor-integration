import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, link, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sdkCreateDiagnostic} from './src/network.js';
import {sdkOutputReader} from './src/tool-output.js';
import {NativeBridge} from './src/native.js';
import {CursorTransport} from './src/transport.js';

test('SSH read routes only this SDK project output and respects pagination', async t => {
  const projects = await mkdtemp(join(tmpdir(), 'output-test-'));
  t.after(()=>rm(projects,{recursive:true,force:true}));
  const root = join(projects,'C-Temp-dsh-cursor-abcdef','agent-tools');
  await mkdir(root,{recursive:true});
  const file = join(root,'ce9e0376-ee86-4b81-a36d-f2b073951813.txt');
  await writeFile(file,'first\nsecond\nthird\n');
  const calls=[];
  const bridge=new NativeBridge([{name:'read',parameters:{}}],()=>true,event=>calls.push(event));
  bridge.readSdkOutput=sdkOutputReader('C:/Temp/dsh-cursor-abcdef',projects);
  const execute=bridge.customTools.read.execute;
  const page=await execute({file_path:file,offset:2,limit:1});
  assert.equal(page.isError,false);
  assert.match(page.content[0].text,/2\tsecond/);
  assert.doesNotMatch(page.content[0].text,/first|third/);
  assert.equal(calls.length,0);
  await link(file,join(projects,'duplicate'));
  assert.equal((await execute({file_path:file})).isError,true);
  for(const other of [file.replace('abcdef','another'),file.replace('agent-tools','agent-transcripts'),'/home/devbox/project/main.js']){
    const pending=execute({file_path:other});
    const call=calls.at(-1);
    assert.equal(call.type,'tool-call');
    bridge.resume([{role:'assistant',content:[call]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:'host result'}]}]);
    assert.equal((await pending).content[0].text,'host result');
  }
});

test('Agent.create exposes only recognized diagnostic values through the transport',async()=>{
  const raw=Object.assign(new Error('private key material'),{name:'RateLimitError',status:429,code:'secret',cause:{code:'ECONNRESET'}});
  raw.cause.cause=raw;
  assert.deepEqual(sdkCreateDiagnostic(raw),['RateLimitError','HTTP 429','ECONNRESET']);
  const transport=new CursorTransport({loadSDK:async()=>({JsonlLocalAgentStore:class {},Agent:{create:async()=>{throw raw;}}})});
  await assert.rejects(async()=>{for await(const event of transport.stream({apiKey:'test-fixture',model:{id:'test'},messages:[],prompt:'test'})) void event;},err=>{
    assert.match(err.message,/Agent\.create.*HTTP 429.*ECONNRESET/);
    assert.doesNotMatch(err.message,/secret|private/);
    return true;
  });
});
