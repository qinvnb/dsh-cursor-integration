import assert from 'node:assert/strict';
import test from 'node:test';
import {createUsageStore} from './src/usage/ui-store.js';

test('a fixed account is available and confirmed before the full usage snapshot returns', async t => {
  let finishRefresh;
  let reads=0;
  const keys=[{id:'a',label:'A'},{id:'b',label:'B',account:{status:'pending'}}];
  const store=createUsageStore({
    getSnapshot:()=>{
      if(++reads===1)return new Promise(resolve=>{finishRefresh=resolve;});
      return Promise.resolve({ok:true,value:{active:keys[1],keys,pool:{manual:true}}});
    },
    selectKey:async id=>({ok:true,value:{
      ok:true,active:keys.find(row=>row.id===id),keys,manual:true,fallback:id,defaults:{claude:id},
    }}),
  });
  t.after(()=>store.dispose());
  const pending=store.refresh();
  await Promise.resolve();
  const result=await store.selectKey('b');
  assert.equal(result.fallback,'b');
  assert.equal(store.getSnapshot().switching,false);
  assert.equal(store.getSnapshot().data.active.id,'b');
  assert.equal(store.getSnapshot().data.pool.manual,true);
  assert.equal(reads,1);
  finishRefresh({ok:true,value:{active:keys[0],keys,pool:{manual:false}}});
  await pending;
  await store.refresh();
  assert.equal(reads,2);
  assert.equal(store.getSnapshot().data.active.id,'b');
});
