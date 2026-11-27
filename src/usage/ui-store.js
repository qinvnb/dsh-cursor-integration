/** Shared polling for the settings page and every conversation footer. */
export function createUsageStore(api, {
  setTimer = setInterval,
  clearTimer = clearInterval,
  setTimeoutImpl = typeof setTimeout === 'function' ? setTimeout : undefined,
  clearTimeoutImpl = typeof clearTimeout === 'function' ? clearTimeout : undefined,
} = {}) {
  let state = {data: null, busy: false, switching:false, error: ''}, pending, timer, scanTimer, stopped = false, generation=0;
  const listeners = new Set();
  const clearScanTimer = () => { if (scanTimer !== undefined) { clearTimeoutImpl?.(scanTimer); scanTimer = undefined; } };
  const publish = value => {if (!stopped) {state = {...state, ...value}; for (const listener of listeners) listener();}};
  const refresh = ({silent = false} = {}) => {
    if (pending || stopped || state.switching) return pending;
    const version = generation;
    if (!silent) publish({busy: true});
    pending = Promise.resolve().then(() => api.getSnapshot()).then(result => {
      if (version !== generation) return;
      if (result.ok) {
        publish({data: result.value, error: ''});
        if (result.value?.local?.scanning && listeners.size > 0 && !stopped && setTimeoutImpl) {
          if (scanTimer === undefined) {
            scanTimer = setTimeoutImpl(() => { scanTimer = undefined; void refresh({silent: true}); }, 1500);
          }
        } else {
          clearScanTimer();
        }
      } else {
        clearScanTimer();
        publish({error: '读取失败，请稍后刷新。'});
      }
    }).catch(() => {clearScanTimer(); if(version===generation)publish({error: 'DSH 连接暂时不可用。'});})
      .finally(() => {pending = undefined; if (!silent) publish({busy: false});});
    return pending;
  };
  return {
    getSnapshot: () => state, refresh,
    async selectKey(id) {
      if (state.switching || stopped) return null;
      generation++;clearScanTimer();publish({switching:true,error:''});
      try {
        const result = await api.selectKey(id);
        if (result.ok && result.value.ok) {
          const {active,keys,manual}=result.value;
          publish({data:{...state.data,active,keys,account:active?.account??null,local:null,
            pool:{...state.data?.pool,manual}},error:''});
          void Promise.resolve(pending).then(() => refresh());
          return result.value;
        }
        publish({error:(result.ok && result.value.error) || '密钥切换失败，请重试。'});
      } catch {publish({error:'DSH 连接暂时不可用，密钥未确认切换。'});}
      finally {publish({switching:false});}
      return null;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && !stopped) {refresh(); timer = setTimer(refresh, 60000);}
      return () => {listeners.delete(listener); if (!listeners.size) {clearTimer(timer); timer = undefined; clearScanTimer();}};
    },
    dispose() {stopped = true; clearTimer(timer); clearScanTimer(); listeners.clear();},
  };
}
