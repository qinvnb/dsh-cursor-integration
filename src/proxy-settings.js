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
  const snapshot = config => ({
    available: true,
    port: readProxyPort(config.proxyUrl),
    agentHttpProtocol: config.agentHttpProtocol === 'http1' ? 'http1' : 'http2',
    proxyAgentRetries: Boolean(config.proxyAgentRetries),
  });

  function get() {
    const row = locate();
    if (!row) return { available: false, error: 'DSH 连接配置暂不可用。' };
    return snapshot({...row.inherited, ...row.override});
  }

  async function setConnection({port, agentHttpProtocol, proxyAgentRetries}) {
    const row = locate();
    if (!row) return { available: false, error: 'DSH 连接配置暂不可用。' };
    if (agentHttpProtocol !== undefined && !['http1','http2'].includes(agentHttpProtocol)) {
      return {...get(), error: '请选择 HTTP/2 或 HTTP/1.1（SSE）。'};
    }
    if (proxyAgentRetries !== undefined && typeof proxyAgentRetries !== 'boolean') {
      return {...get(), error: 'SDK 自动重连开关须为布尔值。'};
    }
    let savedPort;
    try {
      if (port !== undefined) savedPort = readProxyPort(updateProxyPort(undefined, port));
    } catch {
      return { ...get(), error: '代理端口须为 1～65535 的整数。' };
    }

    try {
      let saved;
      await editor.edit(row.entry, (current, inherited) => {
        const next = {...current};
        if (savedPort !== undefined) next.proxyUrl = updateProxyPort(current.proxyUrl ?? inherited.proxyUrl, savedPort);
        if (agentHttpProtocol !== undefined) next.agentHttpProtocol = agentHttpProtocol;
        if (proxyAgentRetries !== undefined) next.proxyAgentRetries = proxyAgentRetries;
        saved = snapshot({...inherited, ...next});
        return next;
      });
      return saved;
    } catch {
      return { ...get(), error: 'DSH 未能保存连接设置，请重新打开设置后重试。' };
    }
  }

  return { get, set: port => setConnection({port}), setConnection };
}
