// Account metadata is shared with the provider; credentials stay on the host.
export function createAccountsReader({describe, resolve, createReader, fallbackRef, proxyUrl}) {
  const readers = new Map();
  const preparing = new Map();
  let stopped = false, pendingAll;
  function list() {
    const profile = describe().find(item => item.ns === 'cursor-integration')?.value?.providers?.cursor;
    const activeId = profile?.apiKeyEnv || fallbackRef;
    const rows = [...(Array.isArray(profile?.accounts) ? profile.accounts : [])];
    if (!rows.some(row => row.apiKeyEnv === activeId)) rows.unshift({apiKeyEnv:activeId,label:'默认 API'});
    const seen = new Set();
    return rows.filter(row => typeof row.apiKeyEnv === 'string' && row.apiKeyEnv && !seen.has(row.apiKeyEnv) && seen.add(row.apiKeyEnv))
      .map(row => ({id:row.apiKeyEnv,label:typeof row.label === 'string' && row.label.trim() ? row.label.trim() : '未命名 API',active:row.apiKeyEnv === activeId}));
  }
  async function prepare(meta) {
    let key;
    try {key = (await resolve(meta.id))?.value;} catch {}
    if (stopped) throw new Error('Usage reader stopped');
    let entry = readers.get(meta.id);
    if (!entry || entry.key !== key) {
      await entry?.reader.close();
      if (stopped) throw new Error('Usage reader stopped');
      entry = {key,reader:createReader({proxyUrl,credential:async()=>key})};
      readers.set(meta.id,entry);
    }
    return entry;
  }
  async function read(meta, force = false) {
    if (!preparing.has(meta.id)) preparing.set(meta.id,prepare(meta).finally(()=>preparing.delete(meta.id)));
    const entry = await preparing.get(meta.id);
    const account = await entry.reader.get({force});
    return {...meta,keyHint:typeof entry.key === 'string' && entry.key.length >= 8 ? '••••' + entry.key.slice(-4) : '未配置',account};
  }
  async function prune(rows) {
    const ids = new Set(rows.map(row=>row.id));
    for (const [id,entry] of readers) if (!ids.has(id)) {readers.delete(id);await entry.reader.close();}
  }
  return {
    list, read,
    async current() {
      const rows = list();await prune(rows);
      return read(rows.find(row=>row.active));
    },
    all(force = true) {
      if (pendingAll) return pendingAll;
      pendingAll = (async()=>{
        const rows = list();await prune(rows);
        const results = new Array(rows.length);let next = 0;
        const worker = async()=>{while (next < rows.length) {
          const index = next++;
          try {results[index] = await read(rows[index],force);} catch {
            results[index] = {...rows[index],keyHint:'未读取',account:{status:'error',error:'此密钥的用量查询失败，请重试。',data:null,checkedAt:Date.now(),fetchedAt:null}};
          }
        }};
        await Promise.all(Array.from({length:Math.min(2,rows.length)},worker));
        return {accounts:results};
      })().finally(()=>{pendingAll = undefined;});
      return pendingAll;
    },
    async close() {stopped = true;await Promise.all([...readers.values()].map(entry=>entry.reader.close()));readers.clear();},
  };
}
