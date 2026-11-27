import {ProviderError} from './provider.js';
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const str=v=>typeof v==='string'?v:null;
export function sanitizeUsageCache(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1)return null;
  if(!Number.isFinite(raw.updatedAt)||raw.updatedAt<=0)return null;
  if(!raw.accounts||typeof raw.accounts!=='object'||Array.isArray(raw.accounts))return null;
  const accounts={};
  for(const [id,entry] of Object.entries(raw.accounts)){
    if(typeof id!=='string'||!id||!entry||typeof entry!=='object'||Array.isArray(entry))continue;
    if(!Number.isFinite(entry.fetchedAt)||entry.fetchedAt<=0)continue;
    const data=entry.data;
    if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.meters))continue;
    const meters=[];
    for(const m of data.meters){
      if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.key!=='string'||!m.key||typeof m.unit!=='string')continue;
      meters.push({
        key:m.key,label:typeof m.label==='string'?m.label:m.key,unit:m.unit,
        used:num(m.used),limit:num(m.limit),remaining:num(m.remaining),percent:num(m.percent),
      });
    }
    if(!meters.length)continue;
    accounts[id]={
      fetchedAt:entry.fetchedAt,
      data:{membership:str(data.membership),periodStart:str(data.periodStart),periodEnd:str(data.periodEnd),meters},
    };
  }
  if(!Object.keys(accounts).length)return null;
  return {version:1,updatedAt:raw.updatedAt,accounts};
}
const day = 86400000;
// Calendar days in the desktop timezone, including DST and leap years.
function serial(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / day;
}
export function cycleProgress(now = new Date()) {
  const month = now.getMonth() - Number(now.getDate() < 23);
  const start = new Date(now.getFullYear(), month, 23);
  const end = new Date(now.getFullYear(), month + 1, 23);
  const elapsed = serial(now) - serial(start);
  const days = serial(end) - serial(start);
  return {elapsed, days, percent: elapsed * 100 / days, cycle: start.getTime()};
}
function meter(row, key) {
  return row.account.status === 'ready' && row.account.data?.meters.find(item => item.key === key && Number.isFinite(item.percent));
}
export function totals(rows) {
  return ['auto','api','onDemand'].map(key => {
    const items = rows.map(row => meter(row, key)).filter(Boolean);
    const weighted = items.length > 0 && items.every(item => item.unit === 'usd' && item.limit > 0 && Number.isFinite(item.used));
    const sum = field => items.reduce((value,item) => value + item[field], 0);
    const percent = !items.length ? null : weighted ? 100 * sum('used') / sum('limit') : sum('percent') / items.length;
    const amounts=rows.filter(row=>row.account.status==='ready').map(row=>row.account.data?.meters.find(item=>
      item.key===key && item.unit==='usd' && Number.isFinite(item.used))).filter(Boolean);
    const amountSum=field=>amounts.reduce((value,item)=>value+item[field],0);
    const money=amounts.length?{
      used:amountSum('used'),
      limit:amounts.every(item=>Number.isFinite(item.limit))?amountSum('limit'):null,
      remaining:amounts.every(item=>Number.isFinite(item.remaining)||Number.isFinite(item.limit))?
        amounts.reduce((value,item)=>value+(Number.isFinite(item.remaining)?item.remaining:Math.max(0,item.limit-item.used)),0):null,
      count:amounts.length,total:rows.length,
    }:null;
    return {key, percent, weighted, count:items.length, total:rows.length,money};
  });
}
// SDK model variants share the base model's usage pool. Auto aliases use the
// personal-plan Auto estimate; a dynamic router may select another category.
export function quotaCategory(model) {
  const id = model.split('@')[0].toLowerCase();
  const cursorModels = ['default','auto','auto-smart','composer-2','composer-2.5','grok-4.5','grok-4.6','grok-4.7'];
  return cursorModels.includes(id) ? 'auto' : 'api';
}
export function rank(rows,current,threshold,category='api') {
  const plan = rows.filter(row => meter(row,category) && meter(row,category).percent < 100);
  const demand = row => meter(row,'onDemand')?.percent ?? Infinity;
  plan.sort((a,b) => meter(a,category).percent - meter(b,category).percent || demand(a) - demand(b) || Number(b.id===current)-Number(a.id===current));
  rows = rows.filter(row => !plan.includes(row));
  const known = rows.filter(row => meter(row,'onDemand')).sort((a,b) => meter(a,'onDemand').percent - meter(b,'onDemand').percent);
  const sticky = known.find(row => row.id === current && meter(row,'onDemand').percent < threshold);
  return [...plan,...(sticky?[sticky]:[]),...known.filter(row=>row!==sticky),...rows.filter(row=>!known.includes(row)).sort((a,b)=>Number(b.id===current)-Number(a.id===current))];
}
export function createPool({accounts,resolve,catalog,now=()=>new Date(),interval=()=>5,loadDefaults=()=>({}),saveDefaults=()=>{},loadUsageCache=()=>null,saveUsageCache=()=>{},onModelsChanged=()=>{}}) {
  const cooldownDurations={CURSOR_RATE_LIMITED:300000,CURSOR_AUTH_FAILED:600000};
  let lastAttempt=0, snapshot, pending, timer, stopped=false, selected, manual=false, warning='';
  let saved=loadDefaults();
  const loaded=sanitizeUsageCache(loadUsageCache());
  const cachedAccounts=new Map(
    Object.entries(loaded?.accounts??{}).map(([id,entry])=>[id,{
      status:'ready',data:entry.data,error:null,checkedAt:entry.fetchedAt,fetchedAt:entry.fetchedAt,
    }]),
  );
  let lastSavedAt=loaded?.updatedAt??null;
  const initialRows=accounts.list();
  if(loaded && initialRows.length>0 && initialRows.every(row=>cachedAccounts.has(row.id)) && loaded.updatedAt<=now().getTime()) {
    lastAttempt=loaded.updatedAt;
  }
  const sessions=new Map();
  const cooldowns=new Map();
  const controller=new AbortController();
  const sticky=new Map();
  const isCoolingDown=ref=>{
    const entry=cooldowns.get(ref);
    if(!entry)return false;
    if(entry.until<=now().getTime()){cooldowns.delete(ref);return false;}
    return true;
  };
  function reportFailure(ref,code) {
    const duration=cooldownDurations[code];
    if(typeof ref!=='string'||!ref||!duration)return;
    cooldowns.set(ref,{code,until:now().getTime()+duration});
  }
  function orderedCandidates(modelId) {
    const rows=accounts.list();
    const valid=new Set(rows.map(row=>row.id));
    const list=[];
    const push=id=>{if(id&&valid.has(id)&&!list.includes(id))list.push(id);};
    if(modelId && snapshot?.rankedByModel?.has(modelId)) {
      for(const ref of snapshot.rankedByModel.get(modelId)) push(ref);
      return list;
    }
    push(modelId?saved?.[modelId]:undefined);
    push(rows.find(row=>row.active)?.id);
    for(const row of rows) push(row.id);
    return list;
  }
  const minutes=()=>Math.max(1,Math.min(1440,Math.round(Number(interval())||5)));
  const active=()=>selected;
  const info=()=>({cycle:cycleProgress(now()),warning,manual,refreshMinutes:minutes(),updatedAt:snapshot?.updatedAt??lastSavedAt??null});
  const placeholder=row=>({...row,account:{status:'pending',data:null,checkedAt:null,fetchedAt:null}});
  function view() {
    const rows=accounts.list().map(meta=>{
      const live=snapshot?.byId.get(meta.id);
      if(live)return live;
      const cached=cachedAccounts.get(meta.id);
      if(cached)return {...meta,keyHint:meta.keyHint??'已缓存',account:cached};
      return placeholder(meta);
    });
    return {accounts:rows,totals:snapshot?.totals??(rows.some(row=>row.account.status==='ready')?totals(rows):[])};
  }
  async function rebuild() {
    const {accounts:rawRows}=await accounts.all(true);
    const rows=rawRows.map(row=>{
      if(row.account?.data || !cachedAccounts.has(row.id)) return row;
      const prior=cachedAccounts.get(row.id);
      return {
        ...row,
        account:{
          ...row.account,
          data:prior.data,
          fetchedAt:row.account?.fetchedAt??prior.fetchedAt,
        },
      };
    });
    const candidates=new Map();
    let next=0;
    async function collect() {
      while(next<rows.length && !stopped) {
        const row=rows[next++];
        const key=await resolve(row.id);
        if(!key) continue;
        let models;
        try {models=await catalog(key,controller.signal);} catch(error) {
          const old=snapshot?.candidates.get(row.id);
          if(error.code!=='CURSOR_AUTH_FAILED' && old?.key===key) models=old.models;
        }
        if(models) candidates.set(row.id,{ref:row.id,key,models});
      }
    }
    await Promise.all([collect(),collect()]);
    if(stopped) return;
    const progress=cycleProgress(now());
    const union=new Map();
    const byModel=new Map();
    const rankedByModel=new Map();
    const rankedRows=rows.map(row=>row.account.data && row.account.status==='error' ? {...row,account:{...row.account,status:'ready'}} :row);
    for(const candidate of candidates.values()) for(const model of candidate.models) union.set(model.id,model);
    for(const id of union.keys()) {
      const eligible=rankedRows.filter(row=>candidates.get(row.id)?.models.some(model=>model.id===id));
      const prior=sticky.get(id);
      const category=quotaCategory(id);
      const sorted=rank(eligible,prior?.cycle===progress.cycle?prior.ref:undefined,progress.percent,category);
      rankedByModel.set(id,sorted.map(row=>row.id));
      const [best]=sorted;
      if(!best) continue;
      const plan=meter(best,category), usage=meter(best,'onDemand');
      const demand=!(plan && plan.percent<100);
      const note=!demand?'':!usage?'个人按需用量未知。':usage.percent>=progress.percent?'已达今日软上限，继续使用占比最低的可用账号。':'';
      byModel.set(id,{...candidates.get(best.id),note,demand,cycle:progress.cycle});
    }
    const nextDefaults=Object.fromEntries([...byModel].map(([id,choice])=>[id,choice.ref]));
    if(Object.keys(nextDefaults).length && JSON.stringify(nextDefaults)!==JSON.stringify(saved)) {
      try {
        saveDefaults(nextDefaults);
        saved=nextDefaults;
      } catch {
        warning='无法保存下次启动的默认账号。';
      }
    }
    const updatedAt=now().getTime();
    const activeIds=new Set(accounts.list().map(row=>row.id));
    for(const id of cachedAccounts.keys()) if(!activeIds.has(id)) cachedAccounts.delete(id);
    let hasFreshReady=false;
    for(const row of rows) {
      if(row.account?.status==='ready' && row.account?.data) {
        hasFreshReady=true;
        const fetchedAt=row.account.fetchedAt??updatedAt;
        cachedAccounts.set(row.id,{
          status:'ready',data:row.account.data,error:null,checkedAt:fetchedAt,fetchedAt,
        });
      }
    }
    if(hasFreshReady) {
      lastSavedAt=updatedAt;
      try {
        const payload=sanitizeUsageCache({
          version:1,
          updatedAt,
          accounts:Object.fromEntries([...cachedAccounts].map(([id,entry])=>[id,{fetchedAt:entry.fetchedAt,data:entry.data}])),
        });
        if(payload) saveUsageCache(payload);
      } catch {}
    }
    const models=[...union.values()];
    const fingerprint=rows=>JSON.stringify(rows?.slice().sort((a,b)=>a.id.localeCompare(b.id)));
    const changed=fingerprint(snapshot?.models??[])!==fingerprint(models);
    snapshot={byModel,rankedByModel,candidates,models,byId:new Map(rows.map(row=>[row.id,row])),totals:totals(rows),updatedAt};
    if(changed)onModelsChanged();
  }
  function refresh() {
    if(!pending && !stopped) {
      lastAttempt=now().getTime();
      pending=rebuild().finally(()=>{pending=undefined;});
    }
    return pending;
  }
  function start() {
    const tick=async()=>{
      const rows=accounts.list();
      const missing=rows.some(row=>!snapshot?.byId.has(row.id)&&!cachedAccounts.has(row.id));
      const elapsed=now().getTime()-lastAttempt;
      const due=!lastAttempt||elapsed<0||elapsed>=minutes()*60000;
      try {if(missing||due) await refresh();} catch {warning='后台刷新失败，继续使用已有结果。';}
      if(!stopped){timer=setTimeout(tick,Math.min(60000,Math.max(1,lastAttempt+minutes()*60000-now().getTime())));timer.unref?.();}
    };
    void tick();
  }
  function close(){stopped=true;clearTimeout(timer);controller.abort();}
  async function route(model,signal,pinned,preview=false,sessionId) {
    signal?.throwIfAborted();
    const entries=accounts.list();

    const id=model.split('@')[0];
    const best=snapshot?.byModel.get(id);
    const ref=pinned??plannedRef(id);
    if(!ref||!entries.some(row=>row.id===ref)) throw new ProviderError('MISSING_CREDENTIAL','当前账号密钥已移除。');
    const key=await resolve(ref);
    if(!key) throw new ProviderError('MISSING_CREDENTIAL','当前账号尚未保存密钥。');
    if(!pinned&&!preview&&!manual){selected=ref;warning=best?.note??(cachedAccounts.has(ref)?'':'暂用当前账号，等待后台更新账号池。');if(best?.demand)sticky.set(id,{ref,cycle:best.cycle});else sticky.delete(id);}
    if(sessionId&&!preview){sessions.delete(sessionId);sessions.set(sessionId,{ref,model:id,time:now().getTime()});if(sessions.size>512)sessions.delete(sessions.keys().next().value);}
    const cached=snapshot?.candidates.get(ref);
    return {ref,key,models:cached?.key===key?cached.models:undefined};
  }
  async function models(signal){
    if(snapshot?.models.length) return snapshot.models;
    const row=accounts.list().find(item=>item.active)??accounts.list()[0];
    return row?catalog(await resolve(row.id),signal):[];
  }
  function choose(id){if(id)cooldowns.delete(id);selected=id;manual=Boolean(id);warning='';}
  function plannedRef(model){
    const rows=accounts.list();
    const id=model?.split('@')[0];
    if(manual) return rows.find(row=>row.id===selected)?.id ?? rows.find(row=>row.active)?.id ?? rows[0]?.id;
    const candidates=orderedCandidates(id);
    return candidates.find(ref=>!isCoolingDown(ref)) ?? candidates[0];
  }
  async function failover(model,signal,excludeRefs,sessionId) {
    signal?.throwIfAborted();
    if(manual) return undefined;
    const id=model.split('@')[0];
    const skip=excludeRefs instanceof Set?excludeRefs:new Set(excludeRefs?[excludeRefs]:[]);
    for(const ref of orderedCandidates(id)) {
      if(skip.has(ref)||isCoolingDown(ref)) continue;
      const key=await resolve(ref);
      signal?.throwIfAborted();
      if(!key) continue;
      selected=ref;
      warning='已自动切换至备用可用账号。';
      if(sessionId){sessions.delete(sessionId);sessions.set(sessionId,{ref,model:id,time:now().getTime()});if(sessions.size>512)sessions.delete(sessions.keys().next().value);}
      const cached=snapshot?.candidates.get(ref);
      return {ref,key,models:cached?.key===key?cached.models:undefined};
    }
    return undefined;
  }
  function defaults(){
    const ids=snapshot?.models.map(model=>model.id)??Object.keys(saved??{});
    return Object.fromEntries(ids.map(id=>[id,plannedRef(id)??null]));
  }
  return {route,active,info,choose,models,refresh,view,start,close,plannedRef,defaults,reportFailure,failover,session:id=>sessions.get(id)};
}
