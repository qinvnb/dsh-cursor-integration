import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {compactionSettings} from './src/compaction-settings.js';

test('non-volatile native configuration uses ConfigEditor and preserves other fields',async()=>{
 const entry={options:{id:'compaction-basic'}};
 let config={thresholdRatio:0.7,retainRatio:0.16,modelPolicies:[{provider:'other',model:'m',thresholdRatio:0.9}]},writes=0;
 const editor={configuration:()=>[{entry,inherited:{},override:structuredClone(config)}],edit:async(e,change)=>{
  assert.equal(e,entry);const next=change(structuredClone(config));
  if(next.thresholdRatio<=next.retainRatio)throw Error('native validation');
  config=next;writes++;
 }};
 const control=compactionSettings(editor);
 assert.equal(control.get().thresholdRatio,0.7);
 assert.equal((await control.set(0.55)).thresholdRatio,0.55);
 assert.equal(config.retainRatio,0.16);assert.equal(config.modelPolicies[0].thresholdRatio,0.9);
 assert.ok((await control.set(0.1)).error);assert.equal(config.thresholdRatio,0.55);
 assert.ok((await control.set(1.1)).error);assert.equal(writes,1);
 assert.equal(compactionSettings(undefined).get().available,false);
});

test('UI reads real native value without a SettingsForms namespace and never displays a fake 0.8',async()=>{
 const hooks=[];let at=0,effectStarted=false;const writes=[];
 const api={getCompactionSettings:async()=>({ok:true,value:{available:true,thresholdRatio:0.7}}),setCompactionThreshold:async ratio=>{
  writes.push(ratio);return {ok:true,value:{available:true,thresholdRatio:ratio}};
 }};
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useEffect:fn=>{if(!effectStarted){effectStarted=true;fn();}},useState:initial=>{
  const id=at++;if(!(id in hooks))hooks[id]=initial;return [hooks[id],value=>{hooks[id]=value;}];
 }};
 const code=fs.readFileSync(new URL('./client/settings.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function ','function ');
 const context={React,Icon:()=>null,Menu:()=>null,IconChevronDownOutlineRegular:()=>null};
 vm.runInNewContext(code+'\nglobalThis.Control=CompactionControl;',context);
 const render=()=>{at=0;return context.Control({api});};
 const nodes=v=>v&&typeof v==='object'?[v,...v.children.flatMap(nodes)]:[];
 let tree=render();assert.equal(nodes(tree).find(n=>n.type==='input').props.value,'');
 assert.equal(nodes(tree).find(n=>n.type==='button').props.disabled,true);
 await Promise.resolve();tree=render();assert.equal(nodes(tree).find(n=>n.type==='input').props.value,0.7);
 assert.equal(nodes(tree).find(n=>n.type==='button').props.disabled,false);
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:'0.55'}});
 tree=render();await nodes(tree).find(n=>n.type==='button').props.onClick();
 assert.deepEqual(writes,[0.55]);tree=render();assert.equal(nodes(tree).find(n=>n.type==='input').props.value,0.55);
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:'1.1'}});
 tree=render();await nodes(tree).find(n=>n.type==='button').props.onClick();assert.equal(writes.length,1);
});
