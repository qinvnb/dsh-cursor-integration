// Probe scopes are isolated SDK runs with no DSH tools or conversation input.
export function createRouteChecks({list, select, probe, proxyEnabled, load=()=>({}), save=()=>{}}) {
  const saved=load()??{};
  const results = new Map(Array.isArray(saved.results)?saved.results:[]);
  let rows = Array.isArray(saved.rows)?saved.rows:[], controller, running = false, error = '';
  const fallback = proxyEnabled ? 'proxy' : 'direct';
  function preferred(ref, model) {
    return results.get(JSON.stringify([ref,model.split('@')[0]]))?.direct === '成功' ? 'direct' : fallback;
  }
  function status() {return {running,error,rows:rows.map(row=>({...row})),fallback};}
  async function run(signal) {
    const models = await list(signal);
    rows = [...new Set(models)].map(id=>({id,direct:'待检测',proxy:proxyEnabled?'待检测':'未配置',preferred:fallback}));
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        const account = await select(row.id,signal);
        row.label=account.label;
        for (const mode of (proxyEnabled?['direct','proxy']:['direct'])) {
          if (signal.aborted) return;
          row[mode]='检测中';
          try {
            await probe(mode,row.id,account,AbortSignal.any([signal,AbortSignal.timeout(45000)]));
            row[mode]='成功';
          } catch (failure) {row[mode]=signal.aborted?'已停止':failure.name==='TimeoutError'?'超时':'失败';}
        }
        if(!signal.aborted){results.set(JSON.stringify([account.ref,row.id]),{direct:row.direct,proxy:row.proxy});row.preferred=preferred(account.ref,row.id);}
      } catch {row.direct='无法取得账号';if(proxyEnabled) row.proxy='未检测';}
    }
  }
  function start() {
    if (!running) {
      running=true;error='';rows=[];controller=new AbortController();
      void run(controller.signal).catch(()=>{error='读取模型目录失败，请检查账号与网络。';}).finally(()=>{
        running=false;for(const row of rows) for(const mode of ['direct','proxy']) if(['待检测','检测中'].includes(row[mode]))row[mode]='已停止';
        try {save({rows,results:[...results]});} catch {error='检测结果仅在本次运行中生效，保存失败。';}
      });
    }
    return status();
  }
  function stop(){controller?.abort();return status();}
  return {preferred,status,start,stop,fallback};
}
