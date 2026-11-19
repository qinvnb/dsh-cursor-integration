export const name = 'cursor-manual-compaction';
export const inject = ['commands', 'compaction'];

const failures = new Map([
  ['busy', '当前会话有任务在运行，请等它结束后再压缩。'],
  ['cancelled', '已取消压缩。'],
  ['changed', '压缩期间会话历史发生变化，请重新执行 /compact。'],
  ['summary', '没有生成可用的压缩摘要，请查看会话日志。'],
  ['commit', '摘要替换未完成，请检查当前会话。'],
  ['persistence', '摘要已生成，但会话保存失败。'],
]);
const success = text => ({ kind: 'success', text });
const failure = text => ({ kind: 'error', text });

export function apply(ctx) {
  const active = new Map();
  const lifetime = new AbortController();

  function handler({ agent, commandId, rawInput, signal }) {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const input = rawInput.trim();
    const session = agent.session;
    const previous = active.get(session);
    if (input === 'cancel') {
      if (!previous) return failure('当前会话没有正在运行的手动压缩。');
      if (previous.ended()) return failure('压缩已结束，正在保存结果。');
      previous.controller.abort();
      return success('已请求取消压缩。');
    }
    if (input) return failure('用法：/compact 或 /compact cancel');
    if (previous) return failure('当前会话已在压缩。可使用 /compact cancel 取消。');

    const controller = new AbortController();
    const background = AbortSignal.any([controller.signal, lifetime.signal]);
    const firstSeq = session.seq;
    const job = {
      controller,
      ended() {
        for (let seq = firstSeq; seq < session.seq; seq++) {
          const event = session.eventAt(seq);
          if (event.type === 'compaction/end' && event.data.sourceCommandId === commandId) return true;
        }
        return false;
      },
    };
    active.set(session, job);
    let started = false;
    const run = async () => {
      try {
        // DSH acquires maintenance and emits compaction/start synchronously before awaiting the summarizer.
        const pending = ctx.compaction.compactNow(agent, background, commandId);
        for (let seq = firstSeq; seq < session.seq; seq++) {
          const event = session.eventAt(seq);
          if (event.type === 'compaction/start' && event.data.sourceCommandId === commandId) {
            started = true;
            break;
          }
        }
        const result = await pending;
        return result === null
          ? success('当前没有可压缩的历史。')
          : { ...success('已完成压缩。'), sourceEventSeq: result.summarySeq };
      } catch (error) {
        const message = background.aborted ? failures.get('cancelled') :
          error?.name === 'ManualCompactionError' ? failures.get(error.code) : undefined;
        if (error?.code === 'persistence' || started && !job.ended()) {
          ctx.logger.warn('手动压缩结束：' + (message ?? '未能记录压缩结果。'));
        }
        return failure(message ?? '手动压缩失败，请查看会话日志。');
      } finally {
        active.delete(session);
      }
    };
    job.done = run();
    return started ? success('已开始后台压缩。进度见输入框下方，可用 /compact cancel 取消。') : job.done;
  }

  ctx.effect(function* () {
    yield async () => {
      lifetime.abort();
      await Promise.allSettled([...active.values()].map(job => job.done));
    };
    yield ctx.commands.register({
      definitionId: 'dsh-cursor-integration/manual-compaction',
      name: 'compact',
      description: '在后台压缩会话历史',
      input: { hint: '[cancel]' },
      handler,
    });
  }, 'background manual compaction');
}
