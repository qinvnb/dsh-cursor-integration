export function canRetryTurn({
  cursor,
  retryableFailure,
  running,
  removed,
  openState,
  pendingSubmissions,
  subagent,
  hasQueued,
}) {
  return Boolean(
    cursor
    && retryableFailure !== null
    && retryableFailure !== undefined
    && !running
    && !removed
    && openState === 'open'
    && subagent === null
    && (pendingSubmissions ?? 0) === 0
    && !hasQueued,
  );
}

export async function submitSessionRetry(ctx, sessionId) {
  const binding = sessionId ? ctx?.get?.('sessions')?.binding?.(sessionId) : undefined;
  if (!binding?.session?.prompt) {
    return { ok: false, message: '当前会话暂不可重试' };
  }
  try {
    const res = await binding.session.prompt([], 'queue');
    if (res && res.ok === false) {
      return { ok: false, message: '重试请求未被接受，请直接发送消息继续。' };
    }
    return { ok: true, message: '' };
  } catch {
    return { ok: false, message: '重试请求发送失败，请直接发送消息继续。' };
  }
}
