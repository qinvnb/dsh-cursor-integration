import {ProviderError} from './provider.js';
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
    return {key, percent, weighted, count:items.length, total:rows.length};
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
export function createPool({accounts,resolve,catalog,now=()=>new Date(),interval=()=>5,loadDefaults=()=>({}),saveDefaults=()=>{}}) {
  let lastAttempt=0, snapshot, pending, timer, stopped=false, selected, manual=false, warning='';
  let saved=loadDefaults();
  const sessions=new Map();
  const controller=new AbortController();
  const sticky=new Map();
  const minutes=()=>Math.max(1,Math.min(1440,Math.round(Number(interval())||5)));
  const active=()=>selected;
  const info=()=>({cycle:cycleProgress(now()),warning,manual,refreshMinutes:minutes(),updatedAt:snapshot?.updatedAt??null});
  const placeholder=row=>({...row,account:{status:'pending',data:null,checkedAt:null,fetchedAt:null}});
  function view() {
    const rows=accounts.list().map(meta=>snapshot?.byId.get(meta.id)??placeholder(meta));
    return {accounts:rows,totals:snapshot?.totals??[]};
  }
  async function rebuild() {
    const {accounts:rows}=await accounts.all(true);
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
    const rankedRows=rows.map(row=>row.account.data && row.account.status==='error' ? {...row,account:{...row.account,status:'ready'}} :row);
    for(const candidate of candidates.values()) for(const model of candidate.models) union.set(model.id,model);
    for(const id of union.keys()) {
      const eligible=rankedRows.filter(row=>candidates.get(row.id)?.models.some(model=>model.id===id));
      const prior=sticky.get(id);
      const category=quotaCategory(id);
      const [best]=rank(eligible,prior?.cycle===progress.cycle?prior.ref:undefined,progress.percent,category);
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
    snapshot={byModel,candidates,models:[...union.values()],byId:new Map(rows.map(row=>[row.id,row])),totals:totals(rows),updatedAt:now().getTime()};
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
      try {if(!lastAttempt || now().getTime()-lastAttempt>=minutes()*60000) await refresh();} catch {warning='后台刷新失败，继续使用已有结果。';}
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
    if(!pinned&&!preview&&!manual){selected=ref;warning=best?.note??'暂用当前账号，等待后台更新账号池。';if(best?.demand)sticky.set(id,{ref,cycle:best.cycle});else sticky.delete(id);}
    if(sessionId&&!preview){sessions.delete(sessionId);sessions.set(sessionId,{ref,model:id,time:now().getTime()});if(sessions.size>512)sessions.delete(sessions.keys().next().value);}
    const cached=snapshot?.candidates.get(ref);
    return {ref,key,models:cached?.key===key?cached.models:undefined};
  }
  async function models(signal){
    if(snapshot?.models.length) return snapshot.models;
    const row=accounts.list().find(item=>item.active)??accounts.list()[0];
    return row?catalog(await resolve(row.id),signal):[];
  }
  function choose(id){selected=id;manual=Boolean(id);warning='';}
  function plannedRef(model){
    const rows=accounts.list();
    const id=model?.split('@')[0];
    const best=manual?selected:snapshot?.byModel.get(id)?.ref??saved?.[id];
    return rows.find(row=>row.id===best)?.id ?? rows.find(row=>row.active)?.id ?? rows[0]?.id;
  }
  function defaults(){
    const ids=snapshot?.models.map(model=>model.id)??Object.keys(saved??{});
    return Object.fromEntries(ids.map(id=>[id,plannedRef(id)??null]));
  }
  return {route,active,info,choose,models,refresh,view,start,close,plannedRef,defaults,session:id=>sessions.get(id)};
}
