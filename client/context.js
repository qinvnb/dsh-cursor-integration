import React from 'react';
import { Icon } from './icons.js';
import { Popup } from './popup.js';

const h = React.createElement;
const compactNumber = n => n >= 1000000
  ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M'
  : n >= 1000 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K' : String(n);

export function ContextPill({ route, breakdown }) {
  if (route?.provider !== 'cursor') return null;
  const used = breakdown ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens : undefined;
  const capacity = route.contextWindow;
  const known = Number.isFinite(used) && Number.isFinite(capacity) && capacity > 0;
  const ratio = known ? used / capacity * 100 : undefined;
  const percent = known ? Math.round(ratio) : 0;
  const label = known ? `${percent}% · ${compactNumber(used)} / ${compactNumber(capacity)}` : '用量未知';
  const parts = [
    { name: '系统提示词', tokens: breakdown?.systemTokens, color: '#8b5cf6' },
    { name: '工具定义', tokens: breakdown?.toolsTokens, color: '#0d9488' },
    { name: '对话消息', tokens: breakdown?.messageTokens, color: '#3b82f6' },
  ];
  const percentage = n => known ? (n / capacity * 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%' : '—';
  let offset = 0;
  const segments = parts.map(part => {
    const length = known ? Math.min(Math.max(0, part.tokens / capacity), Math.max(0, 1 - offset)) * 43.9823 : 0;
    const arc = h('circle', {
      key: part.name, cx: 10, cy: 10, r: 7, fill: 'none', stroke: part.color,
      strokeWidth: 2.8, strokeDasharray: `${length} ${43.9823 - length}`,
      strokeDashoffset: -offset * 43.9823, transform: 'rotate(-90 10 10)',
    });
    offset += length / 43.9823;
    return arc;
  });

  return h('span', { className: 'dcp-cursor-context' },
    h(Popup, {
      label: '展开本地上下文明细：' + label,
      trigger: [
        h('svg', { key: 'ring', width: 16, height: 16, viewBox: '0 0 20 20', 'aria-hidden': true },
          h('circle', { cx: 10, cy: 10, r: 7, fill: 'none', stroke: 'currentColor', opacity: .16, strokeWidth: 2.8 }),
          ...segments),
        h('span', { key: 'percent', className: 'dcp-context-label' }, known ? `${percent}%` : '未知'),
        known ? h('span', { key: 'cap', className: 'cu-context-cap' }, `${compactNumber(used)}/${compactNumber(capacity)}`) : null,
      ],
    },
    h('div', null,
      h('strong', { className: 'dcp-context-heading' }, h(Icon, { name: 'chart' }), '上下文占用明细'),
      h('div', { className: 'dcp-context-row' }, h('span', null, '总上下文'), h('span', null, known ? used.toLocaleString() + ' Token' : '未知'), h('span', null, percentage(used))),
      ...parts.map(part => h('div', { key: part.name, className: 'dcp-context-row' },
        h('span', null, h('i', { className: 'dcp-context-dot', style: { background: part.color }, 'aria-hidden': true }), part.name),
        h('span', null, Number.isFinite(part.tokens) ? part.tokens.toLocaleString() + ' Token' : '未知'),
        h('span', null, percentage(part.tokens)))),
      h('div', { className: 'dcp-context-note' }, '容量：' + (Number.isFinite(capacity) ? capacity.toLocaleString() + ' Token' : '未知') + ' · 本地估算，不含 SDK 内部提示和隐藏历史。'))));
}

export function mountContext() {}
