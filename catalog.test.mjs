import test from 'node:test';
import assert from 'node:assert/strict';
import {retryBootstrapRequest,describeCatalogFailure} from './src/network.js';
import {ProviderError} from './src/provider.js';
import {defineAdapter} from './src/adapter.js';
import {LlmError} from '@deepseek-ai/dsh-llm';

test('HTTP 502/503 model discovery recovers on the third attempt',async()=>{
 let calls=0;const bodies=[];
 const response=await retryBootstrapRequest(async()=>{const r=new Response('private upstream response',{status:++calls===3?200:calls===1?502:503});bodies.push(r);return r;},'Cursor model discovery');
 assert.equal(response.status,200);assert.equal(calls,3);assert.equal(bodies[0].body.locked,false);
});
test('persistent HTTP errors stop after three attempts and omit body text',async()=>{
 let count=0;await assert.rejects(retryBootstrapRequest(async()=>{count++;return new Response('secret credential',{status:504});},'Cursor model discovery'),e=>e.code==='CURSOR_SERVICE_FAILED'&&!e.message.includes('secret')&&e.message.includes('504'));
 assert.equal(count,3);
});
test('SDK stable codes and nested causes classify without exposing raw messages',()=>{
 for(const [code,expected] of [['unauthenticated','CURSOR_AUTH_FAILED'],['resource_exhausted','CURSOR_RATE_LIMITED'],['unavailable','CURSOR_SERVICE_FAILED'],['deadline_exceeded','CURSOR_NETWORK_TIMEOUT']]){
 const error=describeCatalogFailure(Object.assign(new Error('secret token'),{code}));assert.equal(error.code,expected);assert.ok(!error.message.includes('secret'));
 }
 assert.equal(describeCatalogFailure(new Error('wrapper',{cause:new ProviderError('CURSOR_SERVICE_FAILED','safe')})).code,'CURSOR_SERVICE_FAILED');
});
test('model-resolution errors cross the DSH boundary as a real LlmError',async()=>{
 const Adapter=defineAdapter({LlmAdapter:class{},LlmError,transport:{catalog:async()=>{throw new ProviderError('CURSOR_AUTH_FAILED','safe authentication summary');}},credential:async()=> 'key',profile:()=>({})});
 await assert.rejects(new Adapter().resolveModel('cursor','model'),e=>e instanceof LlmError&&e.code==='CURSOR_AUTH_FAILED'&&e.failure.code==='CURSOR_AUTH_FAILED');
});

test('one removed configured model cannot hide other models; labels, order and settings remain intact',async()=>{
 const rows=[{id:'gone',name:'Old Gemini'},{id:'live-b',name:'My Claude',inputModalities:['text','image']},'live-a'];
 const snapshot=JSON.stringify(rows);
 const Adapter=defineAdapter({LlmAdapter:class{},credential:async()=>'fake',profile:()=>({models:rows}),transport:{catalog:async()=>[
  {id:'live-a',displayName:'A',parameters:[],variants:[]},{id:'live-b',displayName:'B',parameters:[],variants:[]},
 ]}});
 const adapter=new Adapter(),models=await adapter.listModels();
 assert.deepEqual(models.map(m=>m.id),['live-b','live-a']);assert.equal(models[0].name,'My Claude');assert.deepEqual(models[0].inputModalities,['text','image']);
 assert.equal(JSON.stringify(rows),snapshot);await assert.rejects(adapter.resolveModel('cursor','gone'),{code:'UNKNOWN_MODEL'});
});

test('switching accounts restores models when their entitlement returns and keeps an empty selection empty',async()=>{
 let ids=['live'];let selected=['gone','live'];
 const Adapter=defineAdapter({LlmAdapter:class{},credential:async()=>'fake',profile:()=>({models:selected}),transport:{catalog:async()=>ids.map(id=>({id,parameters:[],variants:[]}))}});
 const adapter=new Adapter();assert.deepEqual((await adapter.listModels()).map(m=>m.id),['live']);
 ids=['gone','live'];assert.deepEqual((await adapter.listModels()).map(m=>m.id),['gone','live']);
 selected=[];assert.deepEqual(await adapter.listModels(),[]);
});
