import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';
import { duplexPair } from 'node:stream';
import tls from 'node:tls';
import { getGlobalDispatcher, ProxyAgent } from 'undici';
import { retryBootstrapRequest } from './network.js';

const scope = new AsyncLocalStorage();
const domains = ['cursor.com', 'cursor.sh', 'cursorapi.com'];
let users = 0;
let restore;

function isCursorHost(hostname) {
  const host = hostname?.toLowerCase().replace(/\.$/, '');
  return domains.some(domain => host === domain || host?.endsWith('.' + domain));
}

const cursorProxy = hostname => isCursorHost(hostname) ? scope.getStore() : undefined;

function tunnel(proxy, target, options) {
  const [socket, bridge] = duplexPair();
  const authority = target.hostname + ':' + (target.port || '443');
  const request = http.request(proxy.url, {
    agent: false,
    method: 'CONNECT',
    path: authority,
    headers: { Host: authority },
  });
  bridge.on('error', () => request.destroy());
  request.on('error', error => socket.destroy(error));
  socket.on('close', () => {
    request.destroy();
    bridge.destroy();
  });
  request.on('connect', (response, upstream, head) => {
    if (response.statusCode !== 200) {
      upstream.destroy();
      socket.destroy(new Error('Cursor proxy CONNECT returned HTTP ' + response.statusCode));
      return;
    }
    upstream.on('error', error => socket.destroy(error));
    bridge.on('close', () => upstream.destroy());
    if (head.length) upstream.unshift(head);
    bridge.pipe(upstream).pipe(bridge);
  });
  request.end();
  const connection = tls.connect({ ...options, socket, servername: options.servername || target.hostname, ALPNProtocols: ['h2'] });
  proxy.connections.add(connection);
  connection.once('close', () => proxy.connections.delete(connection));
  return connection;
}

function install() {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalGet = https.get;
  const originalConnect = http2.connect;

  globalThis.fetch = function (input, options) {
    let target;
    try { target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch {}
    const proxy = target?.protocol === 'https:' && cursorProxy(target.hostname);
    if (!proxy) return originalFetch.call(this, input, options);
    const settings = { ...options, dispatcher: proxy.dispatcher };
    const method = (options?.method ?? 'GET').toUpperCase();
    let operation;
    if (target.pathname === '/auth/exchange_user_api_key' && method === 'POST') operation = 'Cursor credential exchange';
    if (target.pathname === '/v1/models' && method === 'GET') operation = 'Cursor model discovery';
    const replayable = (typeof input === 'string' || input instanceof URL)
      && (options?.body === undefined || typeof options.body === 'string');
    if (!operation || !replayable) return originalFetch.call(this, input, settings);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, proxy.controller.signal]) : proxy.controller.signal;
    return retryBootstrapRequest(
      () => originalFetch.call(this, input, { ...settings, signal }),
      operation,
      signal,
    );
  };

  https.request = function (input, options, callback) {
    if (!scope.getStore()) return originalRequest.apply(this, arguments);
    const hasUrl = typeof input === 'string' || input instanceof URL;
    const settings = hasUrl ? (typeof options === 'function' ? {} : options ?? {}) : input;
    const target = hasUrl ? new URL(input) : undefined;
    const proxy = cursorProxy(settings.hostname || settings.host || target?.hostname);
    if (!proxy) return originalRequest.apply(this, arguments);
    const withAgent = { ...settings, agent: proxy.agent };
    return hasUrl
      ? originalRequest.call(this, input, withAgent, typeof options === 'function' ? options : callback)
      : originalRequest.call(this, withAgent, options);
  };

  https.get = function (...args) {
    if (!scope.getStore()) return originalGet.apply(this, args);
    const request = https.request(...args);
    request.end();
    return request;
  };

  http2.connect = function (authority, options, listener) {
    if (!scope.getStore()) return originalConnect.apply(this, arguments);
    const target = authority instanceof URL ? authority : new URL(authority);
    const proxy = target.protocol === 'https:' && cursorProxy(target.hostname);
    if (!proxy) return originalConnect.apply(this, arguments);
    const settings = typeof options === 'function' ? {} : options ?? {};
    return originalConnect.call(this, authority, {
      ...settings,
      createConnection: () => tunnel(proxy, target, settings),
    }, typeof options === 'function' ? options : listener);
  };
  syncBuiltinESMExports();

  return () => {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    https.get = originalGet;
    http2.connect = originalConnect;
    syncBuiltinESMExports();
  };
}

export function createCursorProxy(proxyUrl) {
  const url = new URL(proxyUrl);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Cursor proxyUrl must be an HTTP proxy origin without credentials');
  }
  const proxyDispatcher = new ProxyAgent(url.href);
  const dispatcher = {
    dispatch(options, handler) {
      const target = new URL(options.origin);
      const selected = target.protocol === 'https:' && isCursorHost(target.hostname)
        ? proxyDispatcher : getGlobalDispatcher();
      return selected.dispatch(options, handler);
    },
  };
  const agent = new https.Agent({ keepAlive: true, proxyEnv: { HTTPS_PROXY: url.href, NO_PROXY: '' } });
  const proxy = { url, dispatcher, agent, connections: new Set(), controller: new AbortController() };
  if (users++ === 0) restore = install();
  let closed = false;
  return {
    run: task => scope.run(proxy, task),
    async close() {
      if (closed) return;
      closed = true;
      proxy.controller.abort();
      if (--users === 0) restore();
      agent.destroy();
      for (const connection of proxy.connections) connection.destroy();
      await proxyDispatcher.destroy();
    },
  };
}
