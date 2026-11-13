export async function selectSavedKey({settings,credentials}, id, fallbackRef) {
  const document = settings.describe().find(row=>row.ns === 'cursor-integration');
  const profile = document?.value?.providers?.cursor;
  const activeId = profile?.apiKeyEnv || fallbackRef;
  const known = profile?.accounts?.some(row=>row.apiKeyEnv === id) || id === activeId;
  if (!document || !settings.writable || typeof id !== 'string' || !known) return {ok:false,error:'此密钥不可切换，请在 Cursor API 设置中确认。'};
  let saved;
  try {saved = await credentials.resolve(id);} catch {}
  if (!saved?.value) return {ok:false,error:'此密钥尚未保存，请先到 Cursor API 设置填写。'};
  if (id !== activeId) {
    try {await settings.mutate(document.ns,[{op:'set',path:['providers','cursor','apiKeyEnv'],value:id}],document.revision);}
    catch {return {ok:false,error:'切换未成功，配置可能已更新，请刷新后重试。'};}
  }
  return {ok:true};
}

// StoredEntry lifts store out of options; options only retain nav metadata.
export function openUsagePage(slots) {
  const entry = slots.entries('sidebar.settings').find(row=>row.store);
  const actions = entry?.store.create().actions;
  if (typeof actions?.openSection !== 'function') return false;
  actions.openSection('cursor-integration-usage');
  return true;
}
