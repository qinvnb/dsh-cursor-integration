import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

test('the catalog starts collapsed, edits one model at a time, and retains the draft', () => {
  const hooks=[];
  let hook=0;
  const React={
    createElement:(type,props,...children)=>({type,props:props??{},children}),
    useState(initial){
      const index=hook++;
      if(!(index in hooks))hooks[index]=initial;
      return [hooks[index],value=>{hooks[index]=value;}];
    },
    useSyncExternalStore:(_subscribe,get)=>get(),
    useRef:()=>({current:null}),
    useId:()=>'models',
  };
  const context={React,Icon:()=>null,Menu:()=>null,IconChevronDownOutlineRegular:()=>null,structuredClone};
  const code=readFileSync(new URL('./client/settings.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/gm,'').replaceAll('export function ','function ');
  runInNewContext(code+'\nglobalThis.mount=mountSettings;',context);

  const registrations=[];
  const scope={getSnapshot:()=>({status:'ready',writable:true,value:{providers:{cursor:{
    apiKeyEnv:'CURSOR_TEST', models:[{id:'claude',name:'Claude'},{id:'composer',name:'Composer'}],
  }}}})};
  const child={
    effect:callback=>callback(),
    configForms:{whileServed:(_names,callback)=>callback(),get:()=>scope},
    remote:{},
    slots:{
      inject:(_name,callback)=>callback(),
      register:(options,component)=>{registrations.push({options,component});return ()=>{};},
    },
  };
  context.mount({inject:(_names,callback)=>callback(child)});
  const section=registrations.find(entry=>entry.options.name==='settings.section');
  const icon=registrations.find(entry=>entry.options.name==='settings.section.icon');
  assert.equal(icon.options.id,section.options.id);
  assert.equal(icon.component({size:16}).props.name,'model');

  const nodes=value=>value&&typeof value==='object'?[value,...value.children.flatMap(nodes)]:[];
  function draw(){
    hook=0;
    const panel=section.component({});
    const tree=nodes(panel.type(panel.props));
    const button=id=>tree.find(node=>node.type==='button'&&node.props['aria-controls']===id);
    return {button,inputs:tree.filter(node=>node.type==='input')};
  }
  assert.equal(draw().button('models').props['aria-expanded'],false);
  assert.equal(draw().button('models-claude'),undefined);
  draw().button('models').props.onClick();
  assert.equal(draw().button('models-claude').props['aria-expanded'],false);
  draw().button('models-claude').props.onClick();
  draw().inputs.find(input=>input.props.value==='Claude').props.onChange({target:{value:'Claude custom'}});
  draw().button('models-composer').props.onClick();
  assert.equal(draw().button('models-claude').props['aria-expanded'],false);
  assert.equal(draw().button('models-composer').props['aria-expanded'],true);
  draw().button('models').props.onClick();
  draw().button('models').props.onClick();
  draw().button('models-claude').props.onClick();
  assert.ok(draw().inputs.some(input=>input.props.value==='Claude custom'));
});
