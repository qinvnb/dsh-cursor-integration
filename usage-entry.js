import React from 'react';
import {Menu, IconChevronDownOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives';
import {remoteInfo} from './src/usage/remote.js';
import {createUsageStore} from './src/usage/ui-store.js';
import {styles} from './src/usage/styles.js';
import {openUsagePage} from './src/usage/switch.js';
const h = React.createElement;
const money = n => n === null || n === undefined ? '未提供' : '$' + n.toFixed(2);
const number = n => typeof n === 'number' ? n.toLocaleString('zh-CN') : '—';
const percent = n => typeof n === 'number' ? n.toFixed(1).replace(/\.0$/, '') + '%' : '—';
const date = value => value ? new Date(value).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '—';
const quotaNames = {auto:'Cursor 模型',api:'其它模型',onDemand:'个人按需'};
const tone = (key, value) => typeof value === 'number' && value >= 95 ? 'danger' : typeof value === 'number' && value >= 80 ? 'warn' : key;
function Ring({item, size=14}) {
  const used=item?.percent, value=typeof used==='number'?Math.max(0,Math.min(100,used)):0;
  return h('svg',{width:size,height:size,viewBox:'0 0 16 16',className:'cu-ring cu-tone-'+tone(item?.key,used),'aria-hidden':true},
    h('circle',{cx:8,cy:8,r:5.5,fill:'none',stroke:'var(--dsw-alias-bg-skeleton)',strokeWidth:1.5}),
    value>0?h('circle',{cx:8,cy:8,r:5.5,fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',pathLength:100,strokeDasharray:`${value} 100`,transform:'rotate(-90 8 8)'}):null);
}

export const inject = ['slots', 'remote'];
export async function apply(ctx) {
  await ctx.remote.$mount(remoteInfo);
  let store, api;
  const useUsage = () => React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  function Dock({useProjection,useSession,useInput,sessionId} = {}) {
    const running=useSession?.(s=>s.running)??false;
    const inputModel=useInput?.(s=>typeof s.model==='string'?s.model:s.model?.id);
    const [display,setDisplay]=React.useState(null);
    const modelRoute=useProjection?.('cursorContextRoute');
    const compaction=useProjection?.('cursorCompactionStatus');
    const {data, busy, switching, error} = useUsage();
    const [keyMenuOpen,setKeyMenuOpen] = React.useState(false);
    const [navigationError,setNavigationError] = React.useState('');
    const keyRef = React.useRef(null);
    const model=(running?modelRoute?.model:inputModel||modelRoute?.model)?.split('@')[0];
    React.useEffect(()=>{
      let alive=true,timer;
      async function read(){try{const r=await api.getDisplayState(sessionId??'');if(alive&&r.ok)setDisplay(r.value);}finally{if(alive)timer=setTimeout(()=>{read().catch(()=>{});},running?3000:30000);}}
      read().catch(()=>{});return ()=>{alive=false;clearTimeout(timer);};
    },[sessionId,model,running,switching]);
    const ref=running ? (Number.isFinite(modelRoute?.started) && display?.session?.time>=modelRoute.started && display.session.model===model?display.session.ref:modelRoute?.accountRef) : display?.defaults?.[model]??display?.fallback;
    const displayed=display?.keys.find(row=>row.id===ref);
    const account=displayed?.account,info=account?.data;
    const stale = Boolean(error || account?.error);
    const identity = displayed?.label || (running?'等待本轮账号记录':'读取默认账号…');
    const title = ['当前密钥：' + identity, stale ? '数据可能未更新：' + (error || account?.error) : '',
      ...(info?.meters ?? []).map(m => `${m.label}：已用 ${m.unit === 'percent' ? percent(m.percent) : money(m.used)}，剩余 ${m.unit === 'percent' ? percent(m.remaining) : money(m.remaining)}`),
      info ? `账期结束：${date(info.periodEnd)}` : '',
      data?.local?.today ? `DSH 今天：${number(data.local.today.calls)} 次调用，已记录 ${number(data.local.today.totalTokens)} Token（${data.local.today.reportedCalls} 次有用量记录）` : '',
      account?.fetchedAt ? `更新：${date(account.fetchedAt)}` : '', '点击打开 Cursor 用量'].filter(Boolean).join('\n');
    const cursor=modelRoute?.provider==='cursor';
    const checkpoint=display?.sessionId===sessionId?display.path:null;
    const checkpointBusy=checkpoint?.startsWith('正在');
    const checkpointFailed=checkpoint?.includes('失败');
    const checkpointIcon=checkpointFailed?'⚠':checkpointBusy?'↻':checkpoint?.includes('恢复')||checkpoint?.includes('复用')?'✓':'◷';
    const compressionBusy=compaction?.status==='running';
    const compressionFailed=compaction?.status==='failed';
    const compressionText=compressionBusy?'正在生成摘要，请稍候':
      compressionFailed?'压缩失败 · '+compaction.error:
      compaction?.summarized?'摘要压缩已完成 · '+date(compaction.summarized):'尚无成功的摘要压缩记录';
    const statusRow=(label,icon,text,tone,extra)=>h('span',{className:'cu-status-row cu-status-'+tone,role:'status'},
      h('span',{className:'cu-status-icon','aria-hidden':true},icon),
      h('span',{className:'cu-status-label'},label),
      h('span',{className:'cu-status-text'},text),
      extra?h('span',{className:'cu-status-detail'},extra):null);
    return h('span', {className: 'cu-dock', 'aria-label':'Cursor 已用额度'}, h('style', null, styles),
      cursor && statusRow('检查点',checkpointIcon,checkpoint??'等待本轮请求',checkpointFailed?'error':checkpointBusy?'busy':'normal'),
      cursor && statusRow('上下文压缩',compressionFailed?'⚠':compressionBusy?'↻':compaction?.summarized?'✓':'◷',
        compressionText,compressionFailed?'error':compressionBusy?'busy':'normal',
        compaction?.pruned?'工具输出最近裁剪于 '+date(compaction.pruned):null),
      h('span',{className:'cu-quota-row'},
      h(Menu,{open:keyMenuOpen,onClose:()=>setKeyMenuOpen(false),items:[{id:'@auto',label:'自动选账号'},...(data?.keys??[]).map(row=>({id:row.id,label:row.label}))],selectedId:displayed?.id,
        onSelect:async id=>{keyRef.current?.focus({preventScroll:true});setKeyMenuOpen(false);await store.selectKey(id);},align:'start',portal:true,
        anchor:h('button',{ref:keyRef,type:'button',className:'cu-pill cu-key-label',disabled:switching||!data?.keys?.length,
          'aria-label':'切换 Cursor 密钥','aria-haspopup':'menu','aria-expanded':keyMenuOpen,title:'当前密钥：'+identity+'；点击切换，新请求生效',
          onClick:()=>setKeyMenuOpen(!keyMenuOpen)},switching?'切换中…':identity)}),
      modelRoute?.provider==='cursor' && data && h('span',{className:'cu-pill',title:'当前模型新一轮请求的优先线路'},(data.routes?.[modelRoute.model?.split('@')[0]]??data.defaultRoute)==='direct'?'优先直连':'优先代理'),
      ...[['auto','Cursor 模型'],['api','其它模型'],['onDemand','个人按需']].map(([key,label])=>{
        const item=info?.meters.find(m=>m.key===key), used=item?.percent;
        const tooltip=`${label}：已用 ${percent(used)}\n`+(item?.unit==='usd' ? `${money(item.used)} / ${money(item.limit)}，剩余 ${money(item.remaining)}\n` : '')+title;
        return h('button',{key,type:'button',className:'cu-pill',onClick:()=>{setNavigationError(openUsagePage(ctx.slots)?'':'无法打开用量页，请从设置进入。');},title:tooltip,'aria-label':`${label} 已用 ${percent(used)}`,'aria-busy':busy},
          h(Ring,{item}),
          h('span',{className:'cu-pill-text'},label+' '+percent(used)));
      }),stale?h('span',{className:'cu-stale',title},'未更新'):null,
      navigationError?h('span',{className:'cu-stale',role:'status'},navigationError):null));
  }
  function Panel() {
    const {data, busy, error} = useUsage();
    const [range, setRange] = React.useState('cycle');
    const [menuOpen, setMenuOpen] = React.useState(false);
    const selectorRef = React.useRef(null);
    const [all, setAll] = React.useState(null);
    const [allBusy, setAllBusy] = React.useState(false);
    const [allError, setAllError] = React.useState('');
    const [checks,setChecks]=React.useState(null);
    const [checkError,setCheckError]=React.useState('');
    React.useEffect(()=>{
      let alive=true,timer;
      const poll=async()=>{try{const response=await api.getRouteChecks();if(alive&&response.ok){setChecks(response.value);if(response.value.running)timer=setTimeout(poll,1500);else store.refresh();}}catch{if(alive)setCheckError('无法读取检测进度');}};
      void poll();return ()=>{alive=false;clearTimeout(timer);};
    },[checks?.running]);
    async function toggleChecks(){try{setCheckError('');const reply=checks?.running?await api.stopRouteChecks():await api.startRouteChecks();if(reply.ok)setChecks(reply.value);else setCheckError('线路检测操作失败');}catch{setCheckError('线路检测服务暂不可用');}}
    const refreshAll = async()=>{
      if (allBusy) return;
      setAllBusy(true);setAllError('');
      try {
        const result = await api.getAllSnapshots();
        if (result.ok) {setAll(result.value);store.refresh();}
        else setAllError('全部密钥查询失败，请重试。');
      } catch {setAllError('DSH 连接暂时不可用，请重试。');}
      finally {setAllBusy(false);}
    };
    const refresh = store.refresh;
    const account = data?.account, local = data?.local, usage = local?.[range];
    const stat = (label, value, hint) => h('div', {className: 'cu-stat'}, h('span', null, label), h('strong', null, value), hint ? h('small', null, hint) : null);
    const meter = item => h('div',{key:item.key,className:'cu-quota',title:item.key==='api'?'Claude、GPT、Gemini 等其它模型的额度池':item.key==='auto'?'Auto、Composer 等 Cursor 模型的额度池':'个人按需已用金额占上限的比例'},
      h('span',{className:'cu-quota-name'},quotaNames[item.key]??item.label),
      h('div',{className:'cu-quota-ring',role:'img','aria-label':`${quotaNames[item.key]??item.label} 已用 ${percent(item.percent)}`},h(Ring,{item,size:64}),
        h('span',{className:'cu-quota-percent'},percent(item.percent))),
      h('span',{className:'cu-sub'},'已用比例'),
      h('span',{className:'cu-quota-remaining'},'剩余 '+(item.unit==='percent'?percent(item.remaining):money(item.remaining))),
      item.unit==='usd'?h('span',{className:'cu-sub'},money(item.used)+' / '+money(item.limit)):null);
    return h('section', {className: 'cu-root'}, h('style', null, styles),
      h('article',{className:'cu-card'},h('h3',null,'账号池总体用量'),
        h('div',{className:'cu-quotas'},...(data?.totals??[]).map(item=>h('div',{key:item.key,className:'cu-quota'},h('span',null,quotaNames[item.key]),h('div',{className:'cu-quota-ring'},h(Ring,{item,size:64}),h('span',{className:'cu-quota-percent'},percent(item.percent))),h('small',null,(item.weighted?'按额度加权':'账号平均')+' · '+item.count+'/'+item.total+' 个账号')))),
        data?.pool && h('p',{className:'cu-sub'},(data.pool.manual?'手动指定':'自动选账号')+' · 本期已过 '+data.pool.cycle.elapsed+' / '+data.pool.cycle.days+' 天 · 个人按需软上限 '+percent(data.pool.cycle.percent)),
        data?.pool?.warning && h('p',{className:'cu-notice',role:'status'},data.pool.warning)),
      h('article',{className:'cu-card'},h('div',{className:'cu-line'},h('h3',null,'模型线路'),h('button',{type:'button',className:'cu-button',onClick:toggleChecks},checks?.running?'停止检测':'一键检测模型线路')),
        h('p',{className:'cu-sub'},'每个已配置模型分别直连和走代理发送一次短请求，会消耗账号额度。直连成功后，新一轮优先直连。'),
        (checkError||checks?.error)&&h('p',{role:'status'},checkError||checks.error),
        checks?.rows?.length>0 && h('details',{open:true},h('summary',null,'已完成 '+checks.rows.filter(row=>![row.direct,row.proxy].some(value=>['待检测','检测中','已停止'].includes(value))).length+' / '+checks.rows.length),
        h('div',{style:{maxHeight:280,overflow:'auto'}},h('table',null,h('thead',null,h('tr',null,...['模型','直连','代理','优先线路'].map(name=>h('th',{key:name},name)))),h('tbody',null,...checks.rows.map(row=>h('tr',{key:row.id,title:row.label},h('td',null,row.id),h('td',null,row.direct),h('td',null,row.proxy),h('td',null,row.preferred==='direct'?'直连':'代理')))))))),
      h('header', {className: 'cu-line'}, h('div', null, h('h2', null, 'Cursor 账号池'), h('p', {className: 'cu-sub'}, '账号额度 · DSH 调用统计')),
        h('button', {type: 'button', onClick: refresh, disabled: busy}, busy ? '查询中…' : '刷新')),
      error ? h('p', {role: 'alert', className: 'cu-notice'}, error) : null,
      h('article',{className:'cu-card'},
        h('div',{className:'cu-line'},h('div',null,h('h3',null,'当前使用的密钥'),
          h('p',{className:'cu-sub'},data?.active ? data.active.label + ' · ' + data.active.keyHint : '读取中…')),
          h('span',{className:'cu-active-badge'},'使用中')),
        h('p',{className:'cu-sub'},'切换或添加密钥：设置 → Cursor API。仅显示末四位，完整密钥保留在凭据配置中。')),
      h('article',{className:'cu-card'},
        h('div',{className:'cu-line'},h('h3',null,'全部密钥用量'),
          h('button',{type:'button',onClick:refreshAll,disabled:allBusy,'aria-busy':allBusy},allBusy ? '正在查询全部…' : '一键查询全部密钥')),
        h('p',{className:'cu-sub'},'按密钥分别查询当前账期，不会切换当前密钥。同一 Cursor 账号的多个密钥可能显示相同额度，不叠加。'),
        allError ? h('p',{className:'cu-notice',role:'alert'},allError) : null,
        !all ? h('p',{className:'cu-sub'},'点击上方按钮查询所有已保存的密钥。') :
          all.accounts.map(row=>h('section',{key:row.id,className:'cu-account-row'},
            h('div',{className:'cu-line'},h('h3',null,row.label,' ',h('span',{className:'cu-sub'},row.keyHint)),
              row.id===data?.active?.id ? h('span',{className:'cu-active-badge'},'使用中') : null),
            row.account.error ? h('p',{className:'cu-notice',role:'status'},row.account.error,row.account.data ? ' 以下为上次成功的数据。' : '') : null,
            h('div',{className:'cu-quotas'},...['auto','api','onDemand'].map(key=>meter(row.account.data?.meters.find(item=>item.key===key) ?? {key,label:quotaNames[key],percent:null,remaining:null,unit:'percent'}))),
            row.account.data ? h('p',{className:'cu-sub'},'账期 ',date(row.account.data.periodStart),' — ',date(row.account.data.periodEnd)) : null,
            h('p',{className:'cu-sub'},'数据更新 ',date(row.account.fetchedAt))))),
      h('article', {className: 'cu-card'}, h('div', {className: 'cu-line'}, h('h3', null, '账号套餐'), h('span', {className: 'cu-tag'}, ({enterprise:'团队套餐',pro:'Pro',pro_plus:'Pro+',ultra:'Ultra',free:'免费套餐'})[account?.data?.membership]??account?.data?.membership??'读取中')),
        account?.error ? h('p', {className: 'cu-notice', role: 'status'}, account.error, account.data ? ' 以下为上次成功的数据。' : '') : null,
        account?.data ? h(React.Fragment, null,
          h('p', {className: 'cu-sub'}, '账期 ', date(account.data.periodStart), ' — ', date(account.data.periodEnd)),
          h('div',{className:'cu-quotas'},...account.data.meters.map(meter)),
          h('p', {className: 'cu-sub'}, '数据更新 ', date(account.fetchedAt), ' · 账号用量包含其他 Cursor 客户端'))
          : h('p', {className: 'cu-sub'}, busy ? '正在读取官方用量…' : '暂无账号用量')),
      h('article', {className: 'cu-card'}, h('div', {className: 'cu-line'}, h('h3', null, 'DSH 内的 Cursor'),
        h(Menu,{open:menuOpen,onClose:()=>setMenuOpen(false),items:[{id:'today',label:'今天'},{id:'cycle',label:local?.cycleSource==='calendar'?'本月':'当前账期'},{id:'all',label:'全部历史'}],selectedId:range,
          onSelect:id=>{selectorRef.current?.focus({preventScroll:true});setMenuOpen(false);setRange(id);},align:'end',portal:true,
          anchor:h('button',{ref:selectorRef,type:'button',className:'cu-range','aria-label':'统计范围','aria-haspopup':'menu','aria-expanded':menuOpen,onClick:()=>setMenuOpen(!menuOpen)},
            range==='today'?'今天':range==='all'?'全部历史':local?.cycleSource==='calendar'?'本月':'当前账期',h(IconChevronDownOutlineRegular,{'aria-hidden':true}))})),
        local?.error ? h('p', {className: 'cu-notice'}, local.error) : null,
        h('div', {className: 'cu-grid'}, stat('模型调用', number(usage?.calls), usage ? `失败 / 中断 ${number(usage.failed)}` : null),
          stat('Token 合计', number(usage?.totalTokens), usage ? `${usage.reportedCalls} 次有用量记录` : null),
          stat('输入 / 输出', usage ? number(usage.inputTokens) + ' / ' + number(usage.outputTokens) : '—'),
          stat('缓存读 / 写', usage ? number(usage.cacheReadTokens) + ' / ' + number(usage.cacheWriteTokens) : '—')),
        range === 'cycle' && local?.models?.length ? h('div', {className: 'cu-models'}, ...local.models.map(item => h('div', {key: item.model, className: 'cu-line'},
          h('span', null, item.model), h('span', {className: 'cu-sub'}, `${number(item.calls)} 次 · ${number(item.totalTokens)} Token`)))) : null,
        h('p', {className: 'cu-sub', title:'历史仅保存 Token，不按模型标价推算实收费用。'}, 'DSH 单独费用未提供 · 本地历史统计包含所有密钥'),
        local?.skippedSessions ? h('p', {className:'cu-sub'}, `${local.skippedSessions} 个会话未能读取，统计可能不完整。`) : null),
      h('footer', {className: 'cu-sub cu-line'}, h('span',null,'用量后台刷新间隔 '+(data?.pool?.refreshMinutes??5)+' 分钟'), h('a', {href: 'https://cursor.com/dashboard?tab=usage', target: '_blank', rel: 'noopener noreferrer'}, '官网用量 ↗')));
  }
  ctx.inject(['remote.cursorIntegrationUsage'], child => {
    api = child.remote.cursorIntegrationUsage;
    store = createUsageStore(api);
    child.effect(() => () => store.dispose());
    child.slots.inject('settings.section', () => child.slots.register({name: 'settings.section', id: 'cursor-integration-usage', order: 25, label: () => 'Cursor 账号池'}, Panel));
    child.slots.inject('conversation.composer.dock', () => child.slots.register({name:'conversation.composer.dock', id:'cursor-integration-usage', order:10}, Dock));
  });
}

