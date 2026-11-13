import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

test('add, save and switch accounts without overwriting an existing key or storing secrets in settings',async()=>{
 const hooks=[];let cursor=0,renderPanel,registered=0;const writes=[];
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return [hooks[i],v=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;}];},useEffect:()=>{},useSyncExternalStore:(_sub,get)=>get()};
 const state={status:'ready',writable:true,revision:1,value:{providers:{cursor:{apiKeyEnv:'CURSOR_API_KEY'}}}};
 const scope={getSnapshot:()=>state,subscribe:()=>()=>{},async mutate(ops){for(const op of ops){let at=state.value;for(const key of op.path.slice(0,-1))at=at[key]??=( {} );if(op.op==='unset')delete at[op.path.at(-1)];else at[op.path.at(-1)]=op.value;}state.revision++;return true;}};
 const slots={inject:(_name,fn)=>fn(),register:(spec,component)=>{if(spec.name==='settings.section' && spec.id==='cursor-integration-api'){renderPanel=component({view:'editor',useRemoteAccess:()=>true}).type;registered++;}return ()=>{};}};
 const forms={whileServed:(_names,fn)=>fn(),get:()=>scope};
 const ctx={slots,locale:{register:()=>{},bind:()=>key=>key,subscribe:()=>()=>{},getSnapshot:()=>({})},remote:{$mount:async()=>{},credentials:{set:async(ref,key)=>{writes.push({ref,key});return {ok:true};}},llm:{}},inject:(_names,fn)=>fn({remote:{cursorIntegrationUsage:{}},configForms:forms,slots,effect:fn=>fn()} )};
 let plugin;vm.runInNewContext(fs.readFileSync(new URL('./src/client.js',import.meta.url),'utf8'),{setInterval,clearInterval,crypto:webcrypto,window:{__ModuleLoader__:{load:spec=>{plugin=spec.factory(()=>React);}}}});await plugin.apply(ctx);
 assert.equal(registered,1);
 const render=()=>{cursor=0;return renderPanel({scope,view:'page',useRemoteAccess:()=>true});};
 function nodes(v){return v&&typeof v==='object'?[v,...(v.children??[]).flatMap(nodes)]:[];}
 const find=(tree,p)=>{const hit=nodes(tree).find(p);assert.ok(hit,'UI element exists');return hit;};
 let tree=render();find(tree,n=>n.type==='button'&&n.children.includes('添加账号')).props.onClick();
 tree=render();find(tree,n=>n.type==='input'&&n.props.value==='新账号').props.onChange({target:{value:'备用 API'}});
 tree=render();find(tree,n=>n.type==='input'&&n.props.type==='password').props.onChange({target:{value:'fake-test-key'}});
 tree=render();await tree.props.onSubmit({preventDefault(){}});
 assert.equal(writes.length,1);assert.notEqual(writes[0].ref,'CURSOR_API_KEY');
 assert.equal(state.value.providers.cursor.accounts.length,2);assert.equal(state.value.providers.cursor.accounts[0].apiKeyEnv,'CURSOR_API_KEY');
 assert.ok(!JSON.stringify(state.value).includes('fake-test-key'));
 tree=render();find(tree,n=>n.type==='select').props.onChange({target:{value:'CURSOR_API_KEY'}});
 tree=render();await tree.props.onSubmit({preventDefault(){}});
 assert.equal(state.value.providers.cursor.apiKeyEnv,'CURSOR_API_KEY');assert.equal(writes.length,1);
});
