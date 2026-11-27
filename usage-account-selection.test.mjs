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

test('usage store schedules silent follow-up refresh while local scan is running and stops when done', async t => {
  let reads=0;
  const scheduled=[];
  const busyStates=[];
  const store=createUsageStore({
    getSnapshot:async()=>{
      reads++;
      return {ok:true,value:{active:{id:'a',label:'A'},keys:[],local:{scanning:reads<3,all:{calls:reads}}}};
    },
  },{
    setTimer:()=>1,
    clearTimer:()=>{},
    setTimeoutImpl:fn=>{scheduled.push(fn);return scheduled.length;},
    clearTimeoutImpl:()=>{},
  });
  t.after(()=>store.dispose());
  const unsub=store.subscribe(()=>{busyStates.push(store.getSnapshot().busy);});
  await new Promise(r=>setImmediate(r));
  assert.equal(reads,1);
  assert.equal(scheduled.length,1);

  busyStates.length=0;
  scheduled[0]();
  await new Promise(r=>setImmediate(r));
  assert.equal(reads,2);
  assert.equal(busyStates.includes(true),false);
  assert.equal(scheduled.length,2);

  scheduled[1]();
  await new Promise(r=>setImmediate(r));
  assert.equal(reads,3);
  assert.equal(store.getSnapshot().data.local.scanning,false);
  assert.equal(scheduled.length,2);
  unsub();
});
