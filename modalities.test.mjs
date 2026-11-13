import test from 'node:test';
import assert from 'node:assert/strict';
import {defineAdapter} from './src/adapter.js';
test('model variants inherit image declaration and explicit variant overrides win',async()=>{
 const profile={models:[{id:'test',inputModalities:['text','image']}]};
 const catalog=[{id:'test',parameters:[{id:'effort',values:[{value:'high'}]}],variants:[{params:[{id:'effort',value:'high'}]}]}];
 const Adapter=defineAdapter({LlmAdapter:class{},profile:()=>profile,credential:async()=>'fixture',transport:{catalog:async()=>catalog}});
 const adapter=new Adapter();
 assert.deepEqual((await adapter.resolveModel('cursor','test@effort=high')).inputModalities,['text','image']);
 profile.models.push({id:'test@effort=high',inputModalities:['text']});
 assert.deepEqual((await adapter.resolveModel('cursor','test@effort=high')).inputModalities,['text']);
 assert.deepEqual((await adapter.listModels())[0].inputModalities,['text','image']);
});
