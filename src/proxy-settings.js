export function readProxyPort(proxyUrl) {
  if (!proxyUrl) return '';
  const url = URL.parse(proxyUrl);
  return url?.protocol === 'http:' ? url.port || '80' : '';
}

export function updateProxyPort(proxyUrl, input) {
  const port = input.trim();
  if (!port) return '';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new RangeError('Proxy port must be an integer from 1 to 65535');
  }

  const existing = proxyUrl ? URL.parse(proxyUrl) : null;
  const url = existing?.protocol === 'http:' ? existing : new URL('http://127.0.0.1');
  url.port = String(Number(port));
  return url.origin;
}

export function proxySettings(editor, namespace) {
  const locate = () => editor?.configuration().find(row => row.entry.options.id === namespace);

  function get() {
    const row = locate();
    if (!row) return { available: false, error: 'DSH 代理配置暂不可用。' };
    return { available: true, port: readProxyPort(row.override.proxyUrl ?? row.inherited.proxyUrl) };
  }

  async function set(input) {
    const row = locate();
    if (!row) return { available: false, error: 'DSH 代理配置暂不可用。' };
    let savedPort;
    try {
      savedPort = readProxyPort(updateProxyPort(undefined, input));
    } catch {
      return { ...get(), error: '代理端口须为 1～65535 的整数。' };
    }

    try {
      await editor.edit(row.entry, (current, inherited) => ({
        ...current,
        proxyUrl: updateProxyPort(current.proxyUrl ?? inherited.proxyUrl, savedPort),
      }));
      return { available: true, port: savedPort };
    } catch {
      return { ...get(), error: 'DSH 未能写入代理端口，请重新打开设置后重试。' };
    }
  }

  return { get, set };
}
