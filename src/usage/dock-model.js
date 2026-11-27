import { quotaCategory } from '../pool.js';

export function selectDockQuotas(meters, model) {
  const list = Array.isArray(meters) ? meters : [];
  const primaryKey = model ? quotaCategory(model) : 'api';
  const primary = list.find(item => item.key === primaryKey);
  const onDemand = list.find(item => item.key === 'onDemand');
  const primaryExhausted = typeof primary?.percent === 'number' && primary.percent >= 100;
  const activeKey = primaryExhausted ? 'onDemand' : primaryKey;
  const active = primaryExhausted ? onDemand : primary;
  return { primaryKey, primary, onDemand, primaryExhausted, activeKey, active };
}

export function summarizeCheckpoint(checkpoint) {
  const text = typeof checkpoint === 'string' ? checkpoint.trim() : '';
  if (!text || text === '等待本轮请求') {
    return { short: '检查点', detail: '等待本轮请求', tone: 'normal', icon: 'checkpoint' };
  }
  if (/失败|止损/.test(text)) {
    const short = text.includes('止损')
      ? '检查点 · 止损'
      : text.includes('恢复')
        ? '检查点 · 恢复失败'
        : text.includes('重建')
          ? '检查点 · 重建失败'
          : '检查点 · 失败';
    return { short, detail: text, tone: 'error', icon: 'warning' };
  }
  if (/^(?:正在|连接波动|已重新建立连接)/.test(text)) {
    const short = text.startsWith('正在恢复')
      ? '恢复检查点…'
      : text.startsWith('正在重建')
        ? '重建会话…'
        : text.startsWith('正在新建')
          ? '新建会话…'
          : text.startsWith('已重新建立连接')
            ? '已重连…'
            : '自动重连…';
    return { short, detail: text, tone: 'busy', icon: 'refresh' };
  }
  const short = text === '复用当前会话'
    ? '检查点 · 复用'
    : text === '已从检查点恢复'
      ? '检查点 · 已恢复'
      : text === '本轮新建会话'
        ? '检查点 · 新建'
        : (text.startsWith('本轮按历史重建') || text === '按已保存的工具结果重建')
          ? '检查点 · 重建'
          : '检查点';
  return { short, detail: text, tone: 'normal', icon: 'checkpoint' };
}

export function summarizeCompaction(compaction, formatDate = v => String(v)) {
  if (compaction?.status === 'running') {
    return { short: '压缩中…', detail: '正在生成摘要，请稍候', tone: 'busy', icon: 'refresh' };
  }
  if (compaction?.error === '已取消压缩') {
    return { short: '压缩 · 已取消', detail: '已取消压缩', tone: 'normal', icon: 'compress' };
  }
  if (compaction?.status === 'failed') {
    return {
      short: '压缩失败',
      detail: '压缩失败 · ' + (compaction.error || '请稍后重试'),
      tone: 'error',
      icon: 'warning',
    };
  }
  if (compaction?.summarized) {
    return {
      short: '压缩 · 已完成',
      detail: '摘要压缩已完成 · ' + formatDate(compaction.summarized),
      tone: 'normal',
      icon: 'compress',
    };
  }
  if (compaction?.pruned) {
    return { short: '压缩 · 已裁剪', detail: '尚无成功的摘要压缩记录', tone: 'normal', icon: 'compress' };
  }
  return { short: '压缩', detail: '尚无成功的摘要压缩记录', tone: 'normal', icon: 'compress' };
}
