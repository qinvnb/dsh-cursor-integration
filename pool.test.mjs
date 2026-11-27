import test from 'node:test';import assert from 'node:assert/strict';
import {rank,cycleProgress,totals,createPool} from './src/pool.js';
import {sanitizeUsageCache} from './src/route-storage.js';
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

test('pool money sums real USD only and reports incomplete coverage and unknown limits',()=>{
 const rows=[row('a',10,50,10),row('b',30,10,90)];
 const result=totals(rows);
 assert.deepEqual(result[2].money,{used:14,limit:100,remaining:86,count:2,total:2});
 assert.equal(result[1].money,null);
 rows.push({id:'failed',account:{status:'error',data:{meters:[{key:'onDemand',unit:'usd',used:1000,limit:2000,percent:50}]}}});
 rows.push({id:'no-limit',account:{status:'ready',data:{meters:[{key:'onDemand',unit:'usd',used:3,limit:null,remaining:null,percent:null}]}}});
 assert.deepEqual(totals(rows)[2].money,{used:17,limit:null,remaining:null,count:3,total:4});
});
test('a suspended refresh never blocks cold or warm routing, previews, or dock reads',async()=>{
 let finish,reads=0,lookups=0;
 const rows=[{...row('a',60,2),active:true},row('b',10,3)];
 const accounts={list:()=>rows,all:()=>{reads++;return new Promise(resolve=>{finish=()=>resolve({accounts:rows});});}};
 const pool=createPool({accounts,resolve:async id=>id,catalog:async()=>{lookups++;return [{id:'claude'}];}});
 const cold=pool.refresh();assert.equal((await pool.route('claude')).ref,'a');assert.equal(pool.view().accounts[0].account.status,'pending');
 pool.choose('b');
 assert.equal((await pool.route('claude')).ref,'b');
 assert.equal((await pool.route('claude',undefined,'a')).ref,'a');
 assert.equal(lookups,0);finish();await cold;
 assert.equal(pool.info().manual,true);
 pool.choose(undefined);
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

test('cooldown skips rate-limited and auth-failed accounts, clears on manual choose, and falls back when all cool down',async()=>{
 let clock=1000;
 const rows=[row('a',10,0),row('b',50,0)];
 const pool=createPool({
  accounts:{list:()=>rows,all:async()=>({accounts:rows})},
  resolve:async id=>id,
  catalog:async()=>[{id:'claude'}],
  now:()=>new Date(clock),
 });
 await pool.refresh();
 assert.equal((await pool.route('claude')).ref,'a');
 pool.reportFailure('a','CURSOR_RATE_LIMITED');
 assert.equal((await pool.route('claude')).ref,'b');

 // Failover returns undefined when all alternatives are cooling down, and falls back in route()
 pool.reportFailure('b','CURSOR_AUTH_FAILED');
 assert.equal(await pool.failover('claude',undefined,'b'),undefined);
 assert.equal((await pool.route('claude')).ref,'a');

 // Rate limit expires after 5m while auth failure (10m) remains cooled
 clock+=300001;
 assert.equal((await pool.route('claude')).ref,'a');
 assert.equal(await pool.failover('claude',undefined,'a'),undefined);

 // Auth failure expires after 10m total, and manual choose clears cooldown and pins
 clock+=300000;
 const alt=await pool.failover('claude',undefined,'a','sess-1');
 assert.equal(alt?.ref,'b');
 assert.equal(pool.session('sess-1')?.ref,'b');
 pool.reportFailure('b','CURSOR_AUTH_FAILED');
 pool.choose('b');
 assert.equal(await pool.failover('claude',undefined,'b'),undefined);
 assert.equal((await pool.route('claude')).ref,'b');
 pool.close();
});

test('usage cache persists sanitized quota and skips immediate startup fetch within refresh interval',async()=>{
  let clock=1_700_000_000_000;
  let savedCache=null;
  let reads=0;
  const rows=[{
    id:'k1',label:'主账号',active:true,keyHint:'••••1234',
    account:{
      status:'ready',error:null,checkedAt:clock,fetchedAt:clock,
      secretToken:'should-not-persist',
      data:{
        membership:'pro',periodStart:'2026-11-23T00:00:00.000Z',periodEnd:'2026-12-23T00:00:00.000Z',
        raw:{secret:true},
        meters:[
          {key:'auto',label:'Cursor 模型',unit:'percent',used:10,limit:100,remaining:90,percent:10,extra:'strip'},
          {key:'api',label:'其它模型',unit:'percent',used:40,limit:100,remaining:60,percent:40},
          {key:'onDemand',label:'按量付费',unit:'usd',used:2.5,limit:20,remaining:17.5,percent:12.5},
        ],
      },
    },
  }];
  const pool=createPool({
    accounts:{list:()=>[{id:'k1',label:'主账号',active:true}],all:async()=>{reads++;return {accounts:rows};}},
    resolve:async()=>'k1',
    catalog:async()=>[{id:'claude'}],
    now:()=>new Date(clock),
    interval:()=>5,
    loadUsageCache:()=>savedCache,
    saveUsageCache:v=>{savedCache=v;},
  });
  await pool.refresh();
  assert.equal(reads,1);
  assert.ok(savedCache);
  assert.equal(JSON.stringify(savedCache).includes('should-not-persist'),false);
  assert.equal(JSON.stringify(savedCache).includes('extra'),false);
  assert.equal(savedCache.accounts.k1.data.raw,undefined);
  pool.close();

  // Restart 2 minutes later (within 5-minute interval): hydrated view has cached data and start() skips immediate fetch
  clock+=120_000;
  let coldReads=0;
  const restarted=createPool({
    accounts:{list:()=>[{id:'k1',label:'主账号',active:true}],all:async()=>{coldReads++;return {accounts:rows};}},
    resolve:async()=>'k1',
    catalog:async()=>[{id:'claude'}],
    now:()=>new Date(clock),
    interval:()=>5,
    loadUsageCache:()=>savedCache,
    saveUsageCache:v=>{savedCache=v;},
  });
  const initialView=restarted.view();
  assert.equal(initialView.accounts[0].account.status,'ready');
  assert.equal(initialView.accounts[0].account.data.meters[1].percent,40);
  assert.equal(initialView.totals[1].percent,40);
  assert.equal(restarted.info().updatedAt,1_700_000_000_000);
  restarted.start();
  await new Promise(r=>setImmediate(r));
  assert.equal(coldReads,0);
  restarted.close();
});

test('usage cache triggers immediate startup fetch when stale, missing a new account, or timestamped in the future',async()=>{
  const nowMs=1_700_000_600_000;
  const cachedEntry=fetchedAt=>({
    fetchedAt,
    data:{
      membership:'pro',periodStart:'2026-11-23T00:00:00.000Z',periodEnd:'2026-12-23T00:00:00.000Z',
      meters:[{key:'api',label:'其它模型',unit:'percent',used:20,limit:100,remaining:80,percent:20}],
    },
  });
  const makePool=({accountsList,cache,minutes=5})=>{
    let reads=0;
    const pool=createPool({
      accounts:{list:()=>accountsList,all:async()=>{reads++;return {accounts:accountsList.map(a=>({...a,account:{status:'ready',fetchedAt:nowMs,data:cachedEntry(nowMs).data}}))};}},
      resolve:async id=>id,
      catalog:async()=>[{id:'claude'}],
      now:()=>new Date(nowMs),
      interval:()=>minutes,
      loadUsageCache:()=>cache,
    });
    return {pool,getReads:()=>reads};
  };

  // 1. Stale (>5m old)
  const stale=makePool({
    accountsList:[{id:'k1',label:'A',active:true}],
    cache:{version:1,updatedAt:nowMs-301_000,accounts:{k1:cachedEntry(nowMs-301_000)}},
  });
  stale.pool.start();
  await new Promise(r=>setImmediate(r));
  assert.equal(stale.getReads(),1);
  stale.pool.close();

  // 2. Missing newly added account k2 even when cache is recent
  const missingAcc=makePool({
    accountsList:[{id:'k1',label:'A',active:true},{id:'k2',label:'B',active:false}],
    cache:{version:1,updatedAt:nowMs-30_000,accounts:{k1:cachedEntry(nowMs-30_000)}},
  });
  missingAcc.pool.start();
  await new Promise(r=>setImmediate(r));
  assert.equal(missingAcc.getReads(),1);
  missingAcc.pool.close();

  // 3. Future updatedAt
  const futureCache=makePool({
    accountsList:[{id:'k1',label:'A',active:true}],
    cache:{version:1,updatedAt:nowMs+60_000,accounts:{k1:cachedEntry(nowMs)}},
  });
  futureCache.pool.start();
  await new Promise(r=>setImmediate(r));
  assert.equal(futureCache.getReads(),1);
  futureCache.pool.close();
});

test('offline error during refresh preserves disk-cached quota data without overwriting cache updatedAt',async()=>{
  const oldTs=1_700_000_000_000;
  const nowTs=oldTs+600_000;
  let savedCount=0;
  const cache={
    version:1,
    updatedAt:oldTs,
    accounts:{
      k1:{
        fetchedAt:oldTs,
        data:{
          membership:'pro',periodStart:'2026-11-23T00:00:00.000Z',periodEnd:'2026-12-23T00:00:00.000Z',
          meters:[{key:'api',label:'其它模型',unit:'percent',used:55,limit:100,remaining:45,percent:55}],
        },
      },
    },
  };
  const pool=createPool({
    accounts:{
      list:()=>[{id:'k1',label:'主账号',active:true}],
      all:async()=>({accounts:[{id:'k1',label:'主账号',active:true,account:{status:'error',error:'用量查询暂时失败',data:null,checkedAt:nowTs,fetchedAt:null}}]}),
    },
    resolve:async()=>'k1',
    catalog:async()=>[{id:'claude'}],
    now:()=>new Date(nowTs),
    loadUsageCache:()=>cache,
    saveUsageCache:()=>{savedCount++;},
  });
  await pool.refresh();
  assert.equal(savedCount,0);
  const acc=pool.view().accounts[0].account;
  assert.equal(acc.status,'error');
  assert.equal(acc.error,'用量查询暂时失败');
  assert.equal(acc.fetchedAt,oldTs);
  assert.equal(acc.data.meters[0].percent,55);
  assert.equal((await pool.route('claude')).ref,'k1');
  pool.close();
});

test('sanitizeUsageCache rejects malformed inputs and strips unknown properties',()=>{
  assert.equal(sanitizeUsageCache(null),null);
  assert.equal(sanitizeUsageCache({version:2,updatedAt:100,accounts:{}}),null);
  assert.equal(sanitizeUsageCache({version:1,updatedAt:-5,accounts:{k1:{fetchedAt:10,data:{meters:[{key:'api',unit:'percent',percent:10}]}}}}),null);
  assert.equal(sanitizeUsageCache({version:1,updatedAt:100,accounts:{k1:{fetchedAt:10,data:{meters:[]}}}}),null);
  const clean=sanitizeUsageCache({
    version:1,updatedAt:100,extraRoot:true,
    accounts:{
      k1:{
        fetchedAt:90,apiKey:'secret',
        data:{
          membership:'pro',periodStart:'2026-11-01',periodEnd:'2026-12-01',secretField:'bad',
          meters:[{key:'api',label:'其它模型',unit:'percent',used:10,limit:100,remaining:90,percent:10,token:'leak'}],
        },
      },
    },
  });
  assert.deepEqual(clean,{
    version:1,updatedAt:100,
    accounts:{
      k1:{
        fetchedAt:90,
        data:{
          membership:'pro',periodStart:'2026-11-01',periodEnd:'2026-12-01',
          meters:[{key:'api',label:'其它模型',unit:'percent',used:10,limit:100,remaining:90,percent:10}],
        },
      },
    },
  });
});
