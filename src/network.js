import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from './provider.js';

const timeoutCodes = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const resetCodes = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
const unavailableCodes = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);
const transientHttp = new Set([408, 500, 502, 503, 504]);

export function sdkCreateDiagnostic(error) {
  const facts = new Set();
  const seen = new Set();
  for (let e = error; e && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (['CursorSdkError','CursorAgentError','AuthenticationError','RateLimitError','ConfigurationError','AgentBusyError','ConnectError','TypeError','AbortError','TimeoutError'].includes(e.name)) facts.add(e.name);
    if (e.name === 'ConnectError' && Number.isInteger(e.code) && e.code >= 1 && e.code <= 16) facts.add('gRPC ' + e.code);
    for (const status of [e.status,e.statusCode,e.response?.status]) {
      if (Number.isInteger(status) && status >= 400 && status <= 599) facts.add('HTTP ' + status);
    }
    if (timeoutCodes.has(e.code) || resetCodes.has(e.code) || unavailableCodes.has(e.code) ||
        ['unauthenticated','permission_denied','resource_exhausted','invalid_argument','failed_precondition','unavailable','internal','connection_stalled','ENOTFOUND'].includes(e.code)) facts.add(e.code);
  }
  return facts.size ? [...facts] : ['no recognized error code'];
}

/** Whitelisted machine facts only; never forward SDK messages, URLs or credentials. */
export function describeCatalogFailure(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof ProviderError) return current;
    const network = describeNetworkFailure(current, 'Cursor model discovery');
    if (network) return network;
    const status = current.status;
    const code = current.code;
    if ([401,403].includes(status) || ['unauthenticated','permission_denied'].includes(code)) return new ProviderError('CURSOR_AUTH_FAILED', 'Cursor 认证失败或账号无权限，请检查 API Key。');
    if (status === 429 || code === 'resource_exhausted') return new ProviderError('CURSOR_RATE_LIMITED', 'Cursor 查询被限流或额度受限，请稍后重试并核对账号用量。');
    if (status === 408 || code === 'deadline_exceeded') return new ProviderError('CURSOR_NETWORK_TIMEOUT', 'Cursor 模型列表查询超时，请检查代理后重试。');
    if (Number.isInteger(status) && status >= 500 && status <= 599 || ['unavailable','internal'].includes(code)) return new ProviderError('CURSOR_SERVICE_FAILED', 'Cursor 模型列表服务暂时异常，请稍后重试。');
    if (['invalid_argument','not_found','failed_precondition'].includes(code)) return new ProviderError('CURSOR_CATALOG_REJECTED', 'Cursor 拒绝了模型列表请求，请核对账号权限或 SDK 兼容性。');
  }
  return new ProviderError('CURSOR_CATALOG_FAILED', 'Cursor 模型列表查询失败，无法识别上游错误类别；未记录凭据或原始响应。');
}

function networkCode(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (timeoutCodes.has(current.code) || resetCodes.has(current.code) || unavailableCodes.has(current.code) || current.code === 'connection_stalled') return current.code;
  }
}

export function describeNetworkFailure(error, operation) {
  if (error instanceof ProviderError) return error;
  const code = networkCode(error);
  if (timeoutCodes.has(code)) return new ProviderError('CURSOR_NETWORK_TIMEOUT', operation + ' timed out. Check the Cursor proxy connection and try again.');
  if (resetCodes.has(code)) return new ProviderError('CURSOR_CONNECTION_RESET', operation + ' lost its connection. Check the Cursor proxy connection and try again.');
  if (unavailableCodes.has(code)) return new ProviderError('CURSOR_CONNECTION_UNAVAILABLE', operation + ' could not establish a connection. Check the configured proxy and network.');
  if (code === 'connection_stalled') return new ProviderError('CURSOR_CONNECTION_STALLED', operation + ' stalled while streaming. Completed tool actions must not be replayed automatically.');
}

/** Used only for replayable credential exchange and model-list fetches. */
export async function retryBootstrapRequest(request, operation, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await request();
      if (!transientHttp.has(response?.status)) return response;
      try { await response.body?.cancel(); } catch {}
      if (attempt === 2) throw new ProviderError(response.status === 408 ? 'CURSOR_NETWORK_TIMEOUT' : 'CURSOR_SERVICE_FAILED', operation + ' failed after 3 attempts (HTTP ' + response.status + '). Please retry later.');
      await delay(attempt === 0 ? 400 : 1200, undefined, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      const code = networkCode(error);
      if (!timeoutCodes.has(code) && !resetCodes.has(code) && !unavailableCodes.has(code)) throw error;
      if (attempt === 2) throw describeNetworkFailure(error, operation);
      await delay(attempt === 0 ? 400 : 1200, undefined, { signal });
    }
  }
}
