import test from 'node:test';import assert from 'node:assert/strict';
import {rank,cycleProgress,totals,createPool} from './src/pool.js';
const row=(id,api,demand,limit=100)=>({id,account:{status:'ready',data:{meters:[{key:'api',unit:'percent',percent:api},{key:'onDemand',unit:'usd',percent:demand,used:demand*limit/100,limit}]}}});

test('a recovered directory notifies selectors once and repeated quota refreshes do not reload models',async()=>{
 const rows=[row('a',20,0)];let ready=false,notifications=0;
 const pool=createPool({accounts:{list:()=>rows,all:async()=>({accounts:rows})},resolve:async()=> 'key',
   catalog:async()=>{if(!ready)throw Error('temporarily unavailable');return [{id:'live'}];},
   onModelsChanged:()=>{notifications++;},
 });
 await pool.refresh();assert.equal(notifications,0);
 ready=true;await pool.refresh();assert.equal(notifications,1);assert.equal((await pool.models())[0].id,'live');
 await pool.refresh();assert.equal(notifications,1);pool.close();
});
test('23rd resets progress with real month length',()=>{for(const [d,elapsed,days] of [[new Date(2026,10,11),19,31],[new Date(2026,10,23),0,30],[new Date(2024,2,1),7,29]]){const c=cycleProgress(d);assert.equal(c.elapsed,elapsed);assert.equal(c.days,days);}});
test('lowest remaining-plan usage outranks low demand, tie broken by demand',()=>{const rows=[row('full',100,0),row('one',1,88),row('two',2,3),row('tie',1,5)];assert.deepEqual(rank(rows,'full',60).map(r=>r.id),['tie','one','two','full']);});
test('exhausted plans keep under-cap demand account and switch at equality',()=>{assert.equal(rank([row('a',100,30),row('b',100,5)],'a',31)[0].id,'a');assert.equal(rank([row('a',100,30),row('b',100,5)],'a',30)[0].id,'b');});
test('eligible pool, boundary transition, all-over warning and pinned continuation',async()=>{let rows=[row('unsupported',1,0),row('a',3,90),row('b',99,5)];const pool=createPool({accounts:{all:async()=>({accounts:rows}),list:()=>rows},resolve:async ref=>ref,catalog:async key=>[{id:key==='unsupported'?'other':'claude'}],now:()=>new Date(2026,10,11)});await pool.refresh();assert.equal((await pool.route('claude')).ref,'a');rows=[row('a',100,50),row('b',100,5)];await pool.refresh();assert.equal((await pool.route('claude')).ref,'b');rows=[row('a',100,75),row('b',100,80)];await pool.refresh();assert.equal((await pool.route('claude')).ref,'a');assert.ok(pool.info().warning);assert.equal((await pool.route('claude',undefined,'b')).ref,'b');});
test('weighted and percent-only aggregation report coverage',()=>{const items=totals([row('a',10,50,10),row('b',30,10,90)]);assert.equal(items[1].percent,20);assert.equal(items[2].percent,14);assert.equal(items[0].count,0);});
test('a suspended refresh never blocks cold or warm routing, previews, or dock reads',async()=>{
 let finish,reads=0,lookups=0;
 const rows=[{...row('a',60,2),active:true},row('b',10,3)];
 const accounts={list:()=>rows,all:()=>{reads++;return new Promise(resolve=>{finish=()=>resolve({accounts:rows});});}};
 const pool=createPool({accounts,resolve:async id=>id,catalog:async()=>{lookups++;return [{id:'claude'}];}});
 const cold=pool.refresh();assert.equal((await pool.route('claude')).ref,'a');assert.equal(pool.view().accounts[0].account.status,'pending');assert.equal(lookups,0);finish();await cold;
 const warm=pool.refresh();assert.equal((await pool.route('claude')).ref,'b');assert.equal((await pool.route('claude',undefined,undefined,true)).ref,'b');assert.equal((await pool.models())[0].id,'claude');assert.equal(pool.view().accounts[0].account.status,'ready');assert.equal(lookups,2);assert.equal(reads,2);finish();await warm;pool.close();
});
test('one background snapshot chooses opposite accounts for Composer/Grok and Claude/GPT', async()=>{
 const rows=[row('a',90,3),row('b',10,2)];
 rows[0].account.data.meters.push({key:'auto',percent:5});rows[1].account.data.meters.push({key:'auto',percent:99});
 const ids=['composer-2.5','grok-4.7','claude-opus-5-5','gpt-5.6-sol'];
 const pool=createPool({accounts:{all:async()=>({accounts:rows}),list:()=>rows},resolve:async id=>id,catalog:async()=>ids.map(id=>({id}))});
 await pool.refresh();for(const [index,id] of ids.entries())assert.equal((await pool.route(id+'@fast=true')).ref,index<2?'a':'b');pool.close();
});
test('model defaults survive restart and active sessions keep independent actual accounts',async()=>{
 const rows=[{...row('WYA',90,2),active:true},row('YYJ',10,3)];let saved={};const config={accounts:{list:()=>rows,all:async()=>({accounts:rows})},resolve:async ref=>ref,catalog:async()=>[{id:'claude'}],loadDefaults:()=>saved,saveDefaults:value=>{saved=value;}};
 const pool=createPool(config);await pool.refresh();assert.equal(pool.defaults().claude,'YYJ');assert.equal((await pool.route('claude',undefined,null,false,'s1')).ref,'YYJ');pool.choose('WYA');await pool.route('claude',undefined,null,false,'s2');assert.equal(pool.session('s1').ref,'YYJ');assert.equal(pool.session('s2').ref,'WYA');pool.close();const fresh=createPool(config);assert.equal((await fresh.route('claude')).ref,'YYJ');fresh.close();
});

test('failed persistence keeps live defaults and retries on the next refresh',async()=>{
 const rows=[{...row('a',80,0),active:true},row('b',10,0)];
 let writes=0;
 const pool=createPool({
  accounts:{list:()=>rows,all:async()=>({accounts:rows})},
  resolve:async id=>id,catalog:async()=>[{id:'claude'}],
  saveDefaults:()=>{if(++writes===1)throw Error('temporary write failure');},
 });
 await pool.refresh();
 assert.equal(pool.defaults().claude,'b');
 assert.equal((await pool.route('claude')).ref,'b');
 await pool.refresh();
 assert.equal(writes,2);
 pool.close();
});
