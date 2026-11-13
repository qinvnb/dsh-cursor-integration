import React from 'react';
import {Icon} from './icons.js';
import {Popup} from './popup.js';
const h=React.createElement;
export function mountContext(ctx){
    function CursorContext({useProjection}) {
      const route = useProjection('cursorContextRoute');
      const breakdown = useProjection('contextBreakdown');
      if (route?.provider !== 'cursor') return null;
      const used = breakdown ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens : undefined;
      const capacity = route.contextWindow;
      const known = Number.isFinite(used) && Number.isFinite(capacity) && capacity > 0;
      const ratio = known ? used / capacity * 100 : undefined;
      const percent = known ? Math.round(ratio) : 0;
      const compactNumber = n => n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M' : n >= 1000 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K' : String(n);
      const label = known ? `${percent}% · ${compactNumber(used)} / ${compactNumber(capacity)}` : '用量未知';
      const parts = [
        {name:'系统提示词',tokens:breakdown?.systemTokens,color:'#8b5cf6'},
        {name:'工具定义',tokens:breakdown?.toolsTokens,color:'#0d9488'},
        {name:'对话消息',tokens:breakdown?.messageTokens,color:'#3b82f6'},
      ];
      const percentage = n => known ? (n / capacity * 100).toLocaleString(undefined,{maximumFractionDigits:2}) + '%' : '—';
      let offset = 0;
      const segments = parts.map(part => {
        const length = known ? Math.min(Math.max(0,part.tokens / capacity),Math.max(0,1-offset))*43.9823 : 0;
        const arc = h('circle',{key:part.name,cx:10,cy:10,r:7,fill:'none',stroke:part.color,strokeWidth:2.8,strokeDasharray:`${length} ${43.9823-length}`,strokeDashoffset:-offset*43.9823,transform:'rotate(-90 10 10)'});
        offset += length / 43.9823; return arc;
      });
      return h('div',{className:'dcp-cursor-context'},
        h('style',null,`body:has(.dcp-cursor-context) [data-dsh-claude-context-meter],body:has(.dcp-cursor-context) [data-dsh-claude-context-panel]{display:none!important}[data-composer-dock]:has(.dcp-cursor-context)>span:has(button[aria-haspopup="dialog"]:is([aria-label^="上下文已用 "],[aria-label$=" of context used"])){display:none!important}.dcp-cursor-context{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 8px;min-height:26px;position:relative;flex-basis:100%;width:100%;font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.dcp-context-label{font-weight:500}.dcp-context-origin{color:var(--dsw-alias-label-tertiary)}.dcp-context-heading{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}.dcp-context-heading svg{color:var(--dsw-alias-label-secondary)}.dcp-context-row{display:grid;grid-template-columns:minmax(100px,1fr) auto 62px;gap:8px;padding:6px 0;align-items:center}.dcp-context-row>span:last-child{text-align:right}.dcp-context-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.dcp-context-note{font-size:12px;line-height:18px;margin-top:8px;color:var(--dsw-alias-label-tertiary)}`),
        h(Popup,{label:'展开本地上下文明细：'+label,trigger:[
          h('svg',{key:'ring',width:18,height:18,viewBox:'0 0 20 20','aria-hidden':true},h('circle',{cx:10,cy:10,r:7,fill:'none',stroke:'currentColor',opacity:.16,strokeWidth:2.8}),...segments),
          h('span',{key:'label',className:'dcp-context-label'},'上下文'),
          h('span',{key:'percent'},known?`${percent}%`:'未知'),
        ]},
        h('div',null,
          h('strong',{className:'dcp-context-heading'},h(Icon,{name:'chart'}),'上下文占用明细'),
          h('div',{className:'dcp-context-row'},h('span',null,'总上下文'),h('span',null,known ? used.toLocaleString()+' Token' : '未知'),h('span',null,percentage(used))),
          ...parts.map(part=>h('div',{key:part.name,className:'dcp-context-row'},h('span',null,h('i',{className:'dcp-context-dot',style:{background:part.color},'aria-hidden':true}),part.name),h('span',null,Number.isFinite(part.tokens)?part.tokens.toLocaleString()+' Token':'未知'),h('span',null,percentage(part.tokens)))),
          h('div',{className:'dcp-context-note'},'容量：'+(Number.isFinite(capacity)?capacity.toLocaleString()+' Token':'未知')+'。各项百分比均占总容量。'),
          h('div',{className:'dcp-context-note'},'本地估算，不含 Cursor SDK 内部提示和隐藏历史；原生转盘来源不同。'))),
        known?h('span',null,`${compactNumber(used)} / ${compactNumber(capacity)}`):null,
        h('span',{className:'dcp-context-origin'},'本地估算'));

    }
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({name:'conversation.composer.dock',id:'cursor-context-estimate',order:2},CursorContext));

}
