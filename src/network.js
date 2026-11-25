import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from './provider.js';

const timeoutCodes = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const resetCodes = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
const unavailableCodes = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);
const transientHttp = new Set([408, 500, 502, 503, 504]);
const cursorDomains = ['cursor.com', 'cursor.sh', 'cursorapi.com'];
const errorNames = new Set([
  'CursorSdkError', 'CursorAgentError', 'AuthenticationError', 'RateLimitError', 'ConfigurationError',
  'AgentBusyError', 'NetworkError', 'UnknownAgentError', 'AgentNotFoundError',
  'RetriableError', 'NonRetriableError', 'ActionRequiredError', 'CancelledError',
  'ConnectError', 'TypeError', 'AbortError', 'TimeoutError',
]);
const connectCodes = new Set([
  'canceled', 'unknown', 'invalid_argument', 'deadline_exceeded', 'not_found', 'already_exists',
  'permission_denied', 'resource_exhausted', 'failed_precondition', 'aborted', 'out_of_range',
  'unimplemented', 'internal', 'unavailable', 'data_loss', 'unauthenticated',
]);
const inferenceErrorTypes = new Set([
  'IMAGE_TOO_LARGE', 'MAX_TOKENS', 'CONVERSATION_TOO_LONG', 'CONTENT_POLICY', 'DEPRECATED',
  'MAX_MODE_REQUIRED', 'MODEL_NO_LONGER_SUPPORTED', 'UNSUPPORTED_REGION', 'OUTDATED_CLIENT',
]);
const h2ErrorCodes = new Set([
  'PROTOCOL_ERROR', 'INTERNAL_ERROR', 'FLOW_CONTROL_ERROR', 'SETTINGS_TIMEOUT', 'STREAM_CLOSED',
  'FRAME_SIZE_ERROR', 'REFUSED_STREAM', 'CANCEL', 'COMPRESSION_ERROR', 'CONNECT_ERROR',
  'ENHANCE_YOUR_CALM', 'INADEQUATE_SECURITY', 'HTTP_1_1_REQUIRED',
]);
const recognizedCodes = new Set([
  ...timeoutCodes, ...resetCodes, ...unavailableCodes, ...connectCodes, ...inferenceErrorTypes,
  'connection_stalled', 'retry_budget_exceeded', 'ENOTFOUND', 'ECONNABORTED', 'ENETDOWN', 'EAI_FAIL', 'ENODATA', 'ESERVFAIL',
  'ABORT_ERR', 'ENOSPC', 'TIMEOUT', 'agent_not_found',
  'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_INVALID_STREAM', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END',
  'RATE_LIMITED', 'RATE_LIMITED_CHANGEABLE', 'RESOURCE_EXHAUSTED',
  'PRO_USER_USAGE_LIMIT', 'PRO_USER_RATE_LIMIT_EXCEEDED', 'FREE_USER_USAGE_LIMIT', 'FREE_USER_RATE_LIMIT_EXCEEDED',
  'API_KEY_RATE_LIMIT', 'GENERIC_RATE_LIMIT_EXCEEDED', 'OPENAI_RATE_LIMIT_EXCEEDED',
  'BAD_API_KEY', 'BAD_USER_API_KEY', 'NOT_LOGGED_IN', 'UNAUTHORIZED', 'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_NOT_FOUND',
  'MODEL_BLOCKED', 'BAD_MODEL_NAME', 'BAD_REQUEST', 'FILE_NOT_FOUND', 'USER_NOT_FOUND', 'NOT_FOUND',
]);
const messageTokenPattern = /\b(UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|UND_ERR_SOCKET|EPIPE|ECONNABORTED|ERR_HTTP2_SESSION_ERROR|ERR_HTTP2_INVALID_STREAM|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ENETDOWN|IMAGE_TOO_LARGE|MAX_TOKENS|CONVERSATION_TOO_LONG|CONTENT_POLICY|MAX_MODE_REQUIRED|MODEL_NO_LONGER_SUPPORTED|UNSUPPORTED_REGION|OUTDATED_CLIENT)\b/g;
const messagePhrases = [
  [/\bbidi_append_deadline_exceeded\b/i, 'bidi_append_deadline_exceeded'],
  [/\bconnection_stalled\b|connection stalled/i, 'connection_stalled'],
  [/\bPING timed out\b/i, 'h2_ping_timeout'],
  [/unsupported content type null/i, 'stream_closed_early'],
  [/ALPN protocol failed to negotiate/i, 'alpn_failure'],
  [/Unexpected seqno/i, 'poll_seqno_gap'],
  [/socket hang up/i, 'socket_hang_up'],
  [/Premature close/i, 'premature_close'],
  [/Connection failed repeatedly/i, 'connection_failed_repeatedly'],
  [/\bConnection failed\b|connection was interrupted/i, 'connection_failed'],
  [/connection aborted/i, 'connection_aborted'],
  [/Session closed with error code/i, 'h2_session_closed'],
  [/\bprotocol error\b/i, 'protocol_error'],
  [/Out of disk space|\bENOSPC\b/i, 'ENOSPC'],
  [/Conversation data missing/i, 'conversation_data_missing'],
  [/Context summarization failed/i, 'summarization_failed'],
  [/Sign in required|Invalid API key|Bad API key|not logged in|\bunauthenticated\b/i, 'unauthenticated'],
  [/Permission Denied|\bpermission_denied\b/i, 'permission_denied'],
  [/rate.?limit|usage.?limit|too many requests|quota exceeded/i, 'rate_limited'],
  [/The server failed \d+ times|\bServer error\b|internal server error/i, 'server_error'],
  [/service unavailable|bad gateway|gateway timeout/i, 'service_unavailable'],
  [/\boverloaded\b|high demand/i, 'overloaded'],
  [/context.?(?:window|length)|prompt.?is.?too.?long|too many tokens/i, 'context_too_long'],
  [/repeated resume attempts made no progress|Agent stopped retrying/i, 'resume_no_progress'],
];

function messageFacts(text, facts) {
  const prefix = /^\[([a-z_]+)\](?:\s|$)/i.exec(text.trim());
  if (prefix) {
    const code = prefix[1].toLowerCase();
    if (connectCodes.has(code)) facts.add(code);
  }
  for (const match of text.matchAll(/\bHTTP\s+(4\d\d|5\d\d)\b/g)) facts.add('HTTP ' + match[1]);
  for (const match of text.matchAll(/http\/2 stream closed with error code ([A-Z0-9_]+)/gi)) {
    const code = match[1].toUpperCase();
    if (h2ErrorCodes.has(code)) facts.add('h2:' + code);
  }
  for (const match of text.matchAll(/\bNGHTTP2_([A-Z0-9_]+)\b/g)) {
    if (h2ErrorCodes.has(match[1])) facts.add('h2:' + match[1]);
  }
  for (const match of text.matchAll(messageTokenPattern)) facts.add(match[1]);
  for (const [pattern, token] of messagePhrases) {
    if (pattern.test(text)) facts.add(token);
  }
}

export function isCursorHost(hostname) {
  const host = hostname?.toLowerCase().replace(/\.$/, '');
  return cursorDomains.some(domain => host === domain || host?.endsWith('.' + domain));
}

export function sdkCreateDiagnostic(error) {
  const facts = new Set();
  const seen = new Set();
  for (let e = error; e;) {
    if (typeof e === 'string') {
      messageFacts(e, facts);
      break;
    }
    if (typeof e !== 'object' || seen.has(e)) break;
    seen.add(e);
    if (errorNames.has(e.name)) facts.add(e.name);
    if (e.name === 'ConnectError' && Number.isInteger(e.code) && e.code >= 1 && e.code <= 16) facts.add('gRPC ' + e.code);
    if (Number.isInteger(e.displayInfo?.connectCode) && e.displayInfo.connectCode >= 1 && e.displayInfo.connectCode <= 16) {
      facts.add('gRPC ' + e.displayInfo.connectCode);
    }
    if (inferenceErrorTypes.has(e.displayInfo?.inferenceRequestErrorType)) facts.add(e.displayInfo.inferenceRequestErrorType);
    for (const status of [e.status, e.statusCode, e.response?.status]) {
      if (Number.isInteger(status) && status >= 400 && status <= 599) facts.add('HTTP ' + status);
    }
    if (recognizedCodes.has(e.code)) facts.add(e.code);
    if (typeof e.message === 'string' && e.message) messageFacts(e.message, facts);
    e = e.cause;
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

const rateLimitFacts = new Set([
  'HTTP 429', 'RateLimitError', 'resource_exhausted', 'rate_limited', 'RESOURCE_EXHAUSTED',
  'RATE_LIMITED', 'RATE_LIMITED_CHANGEABLE', 'PRO_USER_USAGE_LIMIT', 'PRO_USER_RATE_LIMIT_EXCEEDED',
  'FREE_USER_USAGE_LIMIT', 'FREE_USER_RATE_LIMIT_EXCEEDED', 'API_KEY_RATE_LIMIT',
  'GENERIC_RATE_LIMIT_EXCEEDED', 'OPENAI_RATE_LIMIT_EXCEEDED',
]);
const authFacts = new Set([
  'HTTP 401', 'HTTP 403', 'AuthenticationError', 'unauthenticated', 'permission_denied',
  'BAD_API_KEY', 'BAD_USER_API_KEY', 'NOT_LOGGED_IN', 'UNAUTHORIZED',
  'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_NOT_FOUND',
]);
const contextLimitFacts = new Set(['CONVERSATION_TOO_LONG', 'MAX_TOKENS', 'IMAGE_TOO_LARGE', 'context_too_long']);
const runTimeoutFacts = new Set([
  ...timeoutCodes, 'bidi_append_deadline_exceeded', 'deadline_exceeded', 'h2_ping_timeout',
  'TIMEOUT', 'HTTP 408', 'HTTP 504',
]);
const runResetFacts = new Set([
  ...resetCodes, 'connection_failed', 'connection_failed_repeatedly', 'socket_hang_up',
  'premature_close', 'stream_closed_early', 'connection_aborted', 'h2_session_closed',
  'protocol_error', 'resume_no_progress', 'ECONNABORTED', 'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_INVALID_STREAM', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END',
]);
const runUnavailableFacts = new Set([...unavailableCodes, 'alpn_failure', 'ENOTFOUND', 'ENETDOWN', 'EAI_FAIL']);
const runServiceFacts = new Set([
  'HTTP 464', 'unavailable', 'internal', 'server_error', 'service_unavailable', 'overloaded', 'poll_seqno_gap',
]);

export function describeNetworkFailure(error, operation) {
  if (error instanceof ProviderError) return error;
  const code = networkCode(error);
  if (timeoutCodes.has(code)) return new ProviderError('CURSOR_NETWORK_TIMEOUT', operation + ' timed out. Check the Cursor proxy connection and try again.');
  if (resetCodes.has(code)) return new ProviderError('CURSOR_CONNECTION_RESET', operation + ' lost its connection. Check the Cursor proxy connection and try again.');
  if (unavailableCodes.has(code)) return new ProviderError('CURSOR_CONNECTION_UNAVAILABLE', operation + ' could not establish a connection. Check the configured proxy and network.');
  if (code === 'connection_stalled') return new ProviderError('CURSOR_CONNECTION_STALLED', operation + ' stalled while streaming. Completed tool actions must not be replayed automatically.');
}

export function describeRunFailure(error, status) {
  if (status === 'cancelled') return new ProviderError('ABORTED', 'SDK run was cancelled');
  const detail = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  if (/system.?prompt/i.test(detail) && /invalid.?argument|permission|not.allowed|not.enabled|access.denied/i.test(detail)) {
    return new ProviderError('SYSTEM_PROMPT_REJECTED', 'Custom system prompt rejected');
  }
  const facts = sdkCreateDiagnostic(error);
  const recognized = facts[0] === 'no recognized error code' ? [] : facts;
  const direct = describeNetworkFailure(error, 'Cursor model stream');
  if (direct) return new ProviderError(direct.code, direct.message, direct.facts ?? recognized);
  const has = set => recognized.some(fact => set.has(fact));
  const suffix = recognized.length ? ' (' + recognized.join(', ') + ')' : '';
  if (recognized.includes('connection_stalled')) {
    return new ProviderError('CURSOR_CONNECTION_STALLED', 'Cursor model stream stalled while streaming. Completed tool actions must not be replayed automatically.', recognized);
  }
  if (has(rateLimitFacts)) return new ProviderError('CURSOR_RATE_LIMITED', 'Cursor model stream rate limited or quota exceeded' + suffix + '.', recognized);
  if (has(authFacts)) return new ProviderError('CURSOR_AUTH_FAILED', 'Cursor authentication or permission check failed' + suffix + '.', recognized);
  if (has(contextLimitFacts)) return new ProviderError('CURSOR_CONTEXT_TOO_LONG', 'Cursor request exceeded context or payload limits' + suffix + '.', recognized);
  if (has(runTimeoutFacts)) return new ProviderError('CURSOR_NETWORK_TIMEOUT', 'Cursor model stream timed out' + suffix + '. Check the Cursor proxy connection and try again.', recognized);
  if (has(runResetFacts) || recognized.some(fact => fact.startsWith('h2:'))) {
    return new ProviderError('CURSOR_CONNECTION_RESET', 'Cursor model stream lost its connection' + suffix + '. Check the Cursor proxy connection and try again.', recognized);
  }
  if (has(runUnavailableFacts)) {
    return new ProviderError('CURSOR_CONNECTION_UNAVAILABLE', 'Cursor model stream could not establish a connection' + suffix + '. Check the configured proxy and network.', recognized);
  }
  if (has(runServiceFacts) || recognized.some(fact => /^HTTP 5\d\d$/.test(fact))) {
    return new ProviderError('CURSOR_SERVICE_FAILED', 'Cursor model service returned a temporary error' + suffix + '.', recognized);
  }
  return new ProviderError('SDK_RUN_FAILED', recognized.length ? 'SDK run did not complete' + suffix : 'SDK run did not complete', recognized);
}

/** Local diagnostics only: redacts URLs, paths, tokens and credentials from unrecognized SDK run messages. */
export function summarizeUnrecognizedError(error) {
  const raw = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  let text = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  text = text
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:[a-z0-9-]+\.)*cursor(?:api)?\.(?:com|sh)\b/gi, '[host]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[email]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|cookie)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b(?:(?:key|sk|pk|tok|crsr)[-_][A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9._=-]{8,})\b/g, '[token]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, '[path]')
    .replace(/(^|[\s([{"'])(?:\/[A-Za-z0-9._-]+){2,}/g, '$1[path]')
    .replace(/\b(?=[A-Za-z0-9+/_=-]{24,}\b)(?=.*[0-9_=+/])[A-Za-z0-9+/_=-]{24,}\b/g, '[token]')
    .replace(/"[^"]{24,}"|'[^']{24,}'/g, '"[redacted]"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > 160 ? text.slice(0, 157) + '...' : text;
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
