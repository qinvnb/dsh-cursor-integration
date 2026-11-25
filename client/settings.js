import React from 'react';
import {Icon} from './icons.js';
import {Menu,IconChevronDownOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives';
const h=React.createElement;
const sheet=`
.ci-settings{display:grid;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px}
.ci-settings *{box-sizing:border-box}.ci-settings h2,.ci-settings h3,.ci-settings p{margin:0}.ci-settings h2{font-size:16px;font-weight:600}.ci-settings h3{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}.ci-settings h3 svg{color:var(--dsw-alias-label-secondary);flex:none}
.ci-settings .ci-section{display:grid;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-settings-card-fill)}
.ci-settings .ci-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ci-settings .ci-footer{padding-top:4px}.ci-settings .ci-note{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.ci-note svg{flex:none;margin-top:1px}
.ci-settings .ci-notice{padding:10px 12px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.ci-settings .ci-account-select{flex:1;min-width:120px;justify-content:space-between;text-align:left}.ci-account-select>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ci-account-select>svg{flex:none}
@media(max-width:560px){.ci-settings .ci-grid{grid-template-columns:1fr}.ci-settings .ci-section{padding:12px}}
.ci-settings input,.ci-settings select,.ci-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,6px);padding:6px 10px}
.ci-settings label{display:grid;gap:6px;min-width:0}.ci-settings label>input:not([type=checkbox]){width:100%;min-width:0}.ci-settings .ci-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ci-settings .ci-inline>select{flex:1;min-width:120px}.ci-settings button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px}.ci-settings input:focus-visible,.ci-settings select:focus-visible,.ci-settings button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ci-settings .ci-inline label{display:flex;align-items:center}.ci-settings input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary)}
.ci-settings .ci-model{display:grid;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,6px)}
.ci-settings .ci-model-list{display:grid;gap:8px}
.ci-settings .ci-disclosure{width:100%;justify-content:space-between;gap:12px;padding:0;border:0;background:transparent;text-align:left}
.ci-settings .ci-disclosure>span{display:flex;align-items:center;gap:8px;min-width:0}
.ci-settings .ci-disclosure>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.ci-settings .ci-disclosure[aria-expanded=true]>svg{transform:rotate(180deg)}
.ci-settings .ci-model>.ci-disclosure>span{display:grid;gap:0;overflow-wrap:anywhere}
.ci-settings small{color:var(--dsw-alias-label-tertiary)}.ci-settings button{cursor:pointer}.ci-settings button:disabled{opacity:.5;cursor:default}
.ci-settings button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.ci-settings .ci-primary{background:var(--dsw-alias-state-business-primary);color:white}.ci-settings .ci-primary:hover:enabled{filter:brightness(.95);background:var(--dsw-alias-state-business-primary)}.ci-settings .ci-error{color:var(--dsw-alias-state-error-primary)}
`;
const heading=(name,label)=>h('h3',null,h(Icon,{name}),label);
const note=text=>h('p',{className:'ci-note'},h(Icon,{name:'info'}),text);
function modelRow(row) {return typeof row==='string'?{id:row}:structuredClone(row);}
function modelCapabilities(row) {
  const control=row.reasoning;
  const toggle=control?.id==='thinking'&&control.values.every(value=>['true','false'].includes(value.id));
  const reasoning=toggle?'推理可开关':control?'推理 '+control.values.map(value=>value.name).join(' / '):'目录未提供可选推理档位';
  const context=row.maxContext?'目录上限 '+row.maxContext.toLocaleString()+' Token':'Cursor 未公布上下文容量';
  return h('small',null,context+' · '+reasoning);
}
export function CompactionControl({api}) {
  const [snapshot,setSnapshot]=React.useState(null),[draft,setDraft]=React.useState(null),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false);
  React.useEffect(()=>{
    let alive=true;
    api.getCompactionSettings().then(reply=>{
      if(alive)setSnapshot(reply.ok?reply.value:{available:false,error:'读取原生压缩配置失败。'});
    }).catch(()=>{if(alive)setSnapshot({available:false,error:'无法连接 DSH 配置服务。'});});
    return ()=>{alive=false;};
  },[api]);
  const value=draft??snapshot?.thresholdRatio??'';
  const disabled=busy||!snapshot?.available;
  async function save(){
    const ratio=Number(value);
    if(disabled)return;
    if(!Number.isFinite(ratio)||ratio<=0||ratio>1){setNotice('请输入大于 0、不超过 1 的比例。');return;}
    setBusy(true);setNotice('');
    try{
      const reply=await api.setCompactionThreshold(ratio);
      if(!reply.ok)throw Error();
      setSnapshot(reply.value);
      if(reply.value.error)setNotice(reply.value.error);
      else {setDraft(null);setNotice('DSH 原生压缩阈值已保存。');}
    }catch{setNotice('保存失败，请刷新后重试。');}
    finally{setBusy(false);}
  }
  return h('section',{className:'ci-section'},heading('compress','DSH 自动压缩'),
    h('label',null,h('span',null,'压缩触发比例（0～1）'),h('input',{type:'number',min:0.01,max:1,step:0.01,disabled,value,placeholder:snapshot?'不可用':'读取中…',onChange:event=>{setDraft(event.target.value);setNotice('');},onKeyDown:event=>{if(event.key==='Enter'){event.preventDefault();void save();}}})),
    note('直接修改 DSH 原生策略，作用于使用该策略的所有模型；0.7 表示达到容量的 70% 时触发，实际还受输出预留和安全余量限制。模型专属策略如有覆盖，仍以覆盖值为准。'),
    h('button',{type:'button',disabled,onClick:save},h(Icon,{name:'check'}),busy?'保存中…':'保存压缩阈值'),
    (notice||snapshot?.error)?h('p',{className:'ci-note',role:'status'},notice||snapshot.error):null);
}
export function ConnectionControl({api}) {
  const [snapshot,setSnapshot]=React.useState(null);
  const [portDraft,setPortDraft]=React.useState(null);
  const [protocolDraft,setProtocolDraft]=React.useState(null);
  const [retriesDraft,setRetriesDraft]=React.useState(null);
  const [notice,setNotice]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [menuOpen,setMenuOpen]=React.useState(false);
  const protocolButton=React.useRef(null);
  React.useEffect(()=>{
    let alive=true;
    api.getProxySettings().then(reply=>{
      if(alive)setSnapshot(reply.ok?reply.value:{available:false,error:'读取 DSH 连接配置失败。'});
    }).catch(()=>{if(alive)setSnapshot({available:false,error:'无法连接 DSH 配置服务。'});});
    return ()=>{alive=false;};
  },[api]);

  const disabled=busy||!snapshot?.available;
  const protocols=[{id:'http2',label:'HTTP/2（默认）'},{id:'http1',label:'HTTP/1.1（SSE）'}];
  const protocol=protocolDraft??snapshot?.agentHttpProtocol;
  const retries=retriesDraft??Boolean(snapshot?.proxyAgentRetries);
  const portChanged=portDraft!==null&&portDraft.trim()!==snapshot?.port;
  const protocolChanged=protocolDraft!==null&&protocolDraft!==snapshot?.agentHttpProtocol;
  const retriesChanged=retriesDraft!==null&&retriesDraft!==Boolean(snapshot?.proxyAgentRetries);
  const canSave=!disabled&&(portChanged||protocolChanged||retriesChanged);
  async function save(){
    if(!canSave)return;
    setBusy(true);setNotice('');
    try{
      const reply=await api.setConnectionSettings({
        ...(portChanged?{port:portDraft}:{}),
        ...(protocolChanged?{agentHttpProtocol:protocolDraft}:{}),
        ...(retriesChanged?{proxyAgentRetries:retriesDraft}:{}),
      });
      if(!reply.ok)throw Error();
      setSnapshot(reply.value);
      if(!reply.value.error){
        setPortDraft(null);setProtocolDraft(null);setRetriesDraft(null);
        setNotice('连接设置已保存。');
      }
    }catch{setNotice('保存连接设置失败，无法连接 DSH 配置服务。');}
    finally{setBusy(false);}
  }
  return h('div',{className:'ci-section'},
    h('div',{className:'ci-grid'},
      h('label',null,h('span',null,'Cursor SDK 代理端口'),h('input',{
        inputMode:'numeric',disabled,placeholder:'7890',value:portDraft??snapshot?.port??'',
        onChange:event=>{setPortDraft(event.target.value);setNotice('');},
        onKeyDown:event=>{if(event.key==='Enter'){event.preventDefault();void save();}},
      })),
      h('label',null,h('span',null,'Cursor SDK 流式协议'),
        h(Menu,{items:protocols,open:menuOpen,onClose:()=>setMenuOpen(false),selectedId:protocol,
          align:'start',portal:true,
          onSelect:id=>{setProtocolDraft(id);setMenuOpen(false);setNotice('');protocolButton.current?.focus({preventScroll:true});},
          anchor:h('button',{ref:protocolButton,type:'button',className:'ci-account-select',disabled,
            'aria-label':'Cursor SDK 流式协议','aria-haspopup':'menu','aria-expanded':menuOpen,
            onClick:()=>setMenuOpen(!menuOpen)},
            h('span',null,protocols.find(item=>item.id===protocol)?.label??(snapshot?'不可用':'读取中…')),
            h(IconChevronDownOutlineRegular,{'aria-hidden':true})),
        }))),
    h('div',{className:'ci-inline'},h('label',null,h('input',{
      type:'checkbox',disabled,checked:retries,
      onChange:event=>{setRetriesDraft(event.target.checked);setNotice('');},
    }),h('span',null,'启用 Cursor SDK 断流自动重连（代理与直连生效）'))),
    note('代理端口留空时直连；开启断流自动重连后最多连续重连 3 次且无进展 60 秒止损，不影响已完成工具的防重放保护。保存会重新加载 Cursor 集成，请在当前请求结束后切换。'),
    h('div',{className:'ci-inline'},h('button',{type:'button',disabled:!canSave,onClick:save},
      h(Icon,{name:busy?'refresh':'check'}),busy?'保存中…':'保存连接设置')),
    (notice||snapshot?.error)?h('p',{className:'ci-note',role:'status'},notice||snapshot.error):null,
  );
}
export function mountSettings(ctx) {
  const sectionId='cursor-integration-api';
  function Panel({scope,view,compactionApi}) {
    const snapshot=React.useSyncExternalStore(fn=>scope.subscribe(fn),()=>scope.getSnapshot());
    const [draft,setDraft]=React.useState(null);
    const [key,setKey]=React.useState('');
    const [notice,setNotice]=React.useState('');
    const [busy,setBusy]=React.useState(false);
    const [catalog,setCatalog]=React.useState([]);
    const [query,setQuery]=React.useState('');
    const [modelsOpen,setModelsOpen]=React.useState(false);
    const [expandedModel,setExpandedModel]=React.useState(null);
    const [selected,setSelected]=React.useState(null);
    const [accountMenuOpen,setAccountMenuOpen]=React.useState(false);
    const accountButton=React.useRef(null);
    const modelsId=React.useId();
    if(view==='summary')return 'Cursor 集成';
    const saved=snapshot.value?.providers?.cursor??{};
    const config=draft??{
      ...saved,models:saved.models?.map(modelRow),
      accounts:saved.accounts?.length?saved.accounts.map(row=>({...row})):[
        {label:'默认账号',apiKeyEnv:saved.apiKeyEnv??'CURSOR_API_KEY',configured:Boolean(saved.apiKeyEnv)},
      ],
    };
    const ref=selected??config.apiKeyEnv??config.accounts[0]?.apiKeyEnv;
    const account=config.accounts.find(row=>row.apiKeyEnv===ref);
    const disabled=busy||snapshot.status!=='ready'||!snapshot.writable;
    const change=patch=>setDraft({...config,...patch});
    const editModel=(id,patch)=>change({models:config.models.map(row=>row.id===id?{...row,...patch}:row)});
    const editAccount=patch=>change({accounts:config.accounts.map(row=>row.apiKeyEnv===ref?{...row,...patch}:row)});
    const field=(label,props)=>h('label',null,h('span',null,label),h('input',{disabled,...props}));
    async function discover() {
      setBusy(true);setNotice('');
      try {
        const response=await compactionApi.getModelCatalog({
          ref,...(key.trim()?{draftKey:key.trim()}:{}),
        });
        if(!response.ok)throw Error();
        setCatalog(response.value);
        setNotice('模型目录已更新，点击添加需要的模型后保存。');
      } catch {setNotice('模型目录获取失败，请检查账号和代理。');}
      finally {setBusy(false);}
    }
    async function save(event) {
      event.preventDefault();
      const minutes=Number(config.usageRefreshMinutes??5);
      if(!Number.isInteger(minutes)||minutes<1||minutes>1440){setNotice('刷新间隔须为 1～1440 分钟。');return;}
      if(!account?.label.trim()||!account.configured&&!key.trim()){setNotice('请输入账号名称和 API Key。');return;}
      const ids=new Set();
      for(const model of config.models??[]){
        if(!model.id.trim()||ids.has(model.id.trim())){setNotice('模型 ID 不能为空或重复。');return;}
        ids.add(model.id.trim());
        if(model.contextWindow!==undefined&&(!Number.isSafeInteger(model.contextWindow)||model.contextWindow<1)){
          setModelsOpen(true);setExpandedModel(model.id);
          setNotice('上下文容量须为正整数 Token 数。');return;
        }
      }
      setBusy(true);setNotice('');
      try {
        if(key.trim()){
          const response=await ctx.remote.credentials.set(ref,key.trim());
          if(!response.ok)throw Error();
          setKey('');
        }
        const next={
          ...config,apiKeyEnv:ref,usageRefreshMinutes:minutes,
          accounts:config.accounts.map(row=>({...row,label:row.label.trim(),configured:row.apiKeyEnv===ref?true:row.configured})),
        };
        const operations=[{op:'set',path:['providers','cursor'],value:JSON.parse(JSON.stringify(next))}];
        const ok=await scope.mutate(operations,snapshot.revision);
        if(!ok)throw Error();
        setDraft(null);setNotice('配置已保存。');
      } catch {setNotice('保存失败，请刷新配置后重试。');}
      finally {setBusy(false);}
    }
    function addAccount() {
      const apiKeyEnv='CURSOR_INTEGRATION_'+crypto.randomUUID().replaceAll('-','').toUpperCase();
      change({accounts:[...config.accounts,{label:'新账号',apiKeyEnv,configured:false}]});
      setSelected(apiKeyEnv);setKey('');setCatalog([]);
    }
    return h('form',{className:'ci-settings',onSubmit:save},
      h('style',null,sheet),
      h('header',null,h('h2',null,'Cursor 集成'),h('p',{className:'ci-note'},'管理账号、连接和模型；账号用量与线路检测位于「Cursor 用量」。')),
      h('section',{className:'ci-section'},heading('key','账号与凭据'),
      h('div',{className:'ci-inline'},
        h(Menu,{open:accountMenuOpen,onClose:()=>setAccountMenuOpen(false),
          items:config.accounts.map(row=>({id:row.apiKeyEnv,label:row.label})),selectedId:ref,align:'start',portal:true,
          onSelect:id=>{accountButton.current?.focus({preventScroll:true});setSelected(id);setKey('');setCatalog([]);setAccountMenuOpen(false);},
          anchor:h('button',{ref:accountButton,type:'button',className:'ci-account-select',disabled,
            'aria-label':'选择配置账号','aria-haspopup':'menu','aria-expanded':accountMenuOpen,
            onClick:()=>setAccountMenuOpen(!accountMenuOpen)},h('span',null,account?.label??'选择账号'),h(IconChevronDownOutlineRegular,{'aria-hidden':true}))}),
        h('button',{type:'button',disabled,onClick:addAccount},h(Icon,{name:'plus'}),'添加账号'),
        h('button',{type:'button',disabled:disabled||config.accounts.length<2,onClick:()=>{
          const accounts=config.accounts.filter(row=>row.apiKeyEnv!==ref);
          change({accounts,apiKeyEnv:accounts[0].apiKeyEnv});setSelected(accounts[0].apiKeyEnv);setKey('');setCatalog([]);
        }},h(Icon,{name:'trash'}),'移除此账号')),
      h('div',{className:'ci-grid'},
      field('账号名称',{value:account?.label??'',onChange:event=>editAccount({label:event.target.value})}),
      field('Cursor API Key',{type:'password',autoComplete:'new-password',value:key,
        placeholder:account?.configured?'已保存，留空继续使用':'粘贴此账号的 API Key',
        onChange:event=>{setKey(event.target.value);setCatalog([]);}})),
      note('密钥保存在 DSH 凭据服务。保存后，新请求使用当前账号。')),
      h('section',{className:'ci-section'},heading('network','连接与刷新'),
      field('后台用量刷新间隔（分钟）',{type:'number',min:1,max:1440,value:config.usageRefreshMinutes??5,
        onChange:event=>change({usageRefreshMinutes:event.target.value})}),
      note('用量在后台定时刷新。'),
      compactionApi?h(ConnectionControl,{api:compactionApi}):null),
      compactionApi?h(CompactionControl,{api:compactionApi}):note('当前 DSH 未提供原生压缩配置。'),
      h('section',{className:'ci-section'},
      h('h3',null,h('button',{type:'button',className:'ci-disclosure','aria-expanded':modelsOpen,'aria-controls':modelsId,
        onClick:()=>setModelsOpen(!modelsOpen)},
        h('span',null,h(Icon,{name:'model'}),'模型目录',h('small',null,config.models?'已配置 '+config.models.length+' 个':'跟随账号全部模型')),
        h(IconChevronDownOutlineRegular,{'aria-hidden':true}))),
      h('div',{id:modelsId,hidden:!modelsOpen,className:modelsOpen?'ci-model-list':undefined},...(modelsOpen?[
      h('div',{className:'ci-inline'},
        h('button',{type:'button',disabled:disabled||!compactionApi,onClick:discover},h(Icon,{name:'refresh'}),'获取模型目录'),
        h('button',{type:'button',disabled,onClick:()=>change({models:undefined})},'跟随账号全部模型')),
      field('搜索模型',{value:query,onChange:event=>setQuery(event.target.value)}),
      ...catalog.filter(row=>(row.name+' '+row.id).toLowerCase().includes(query.toLowerCase()))
        .filter(row=>!config.models?.some(saved=>saved.id===row.id)).map(row=>h('div',{key:row.id,className:'ci-inline'},
          h('span',null,row.name??row.id),
          modelCapabilities(row),
          h('button',{type:'button',disabled,onClick:()=>change({models:[...(config.models??[]),{id:row.id,name:'Cursor '+(row.name??row.id)}]})},'添加'))),
      ...(config.models??[]).filter(row=>(row.id+' '+(row.name??'')).toLowerCase().includes(query.toLowerCase())).map(row=>{
        const expanded=expandedModel===row.id;
        const editorId=modelsId+'-'+encodeURIComponent(row.id);
        const discovered=expanded?catalog.find(model=>model.id===row.id):undefined;
        return h('div',{key:row.id,className:'ci-model'},
          h('button',{type:'button',className:'ci-disclosure','aria-expanded':expanded,'aria-controls':editorId,
            onClick:()=>setExpandedModel(expanded?null:row.id)},
            h('span',null,h('strong',null,row.name||row.id),row.name&&row.name!==row.id?h('small',null,row.id):null),
            h(IconChevronDownOutlineRegular,{'aria-hidden':true})),
          h('div',{id:editorId,hidden:!expanded,className:expanded?'ci-model-list':undefined},...(expanded?[
          field('显示名称',{value:row.name??'',onChange:event=>editModel(row.id,{name:event.target.value})}),
          field('上下文容量（Token）',{type:'number',min:1,value:row.contextWindow??'',
            onChange:event=>editModel(row.id,{contextWindow:event.target.value?Number(event.target.value):undefined})}),
          h('small',null,row.contextWindow?'当前使用模型手动配置的容量。':config.contextWindow
            ?'继承全局容量 '+config.contextWindow.toLocaleString()+' Token。':'留空时使用 Cursor 目录给出的容量。'),
          discovered?modelCapabilities(discovered):null,
          h('div',{className:'ci-inline'},
            ...['text','image'].map(type=>h('label',{key:type},
              h('input',{type:'checkbox',disabled:disabled||type==='text',checked:type==='text'||row.inputModalities?.includes('image')===true,
                onChange:event=>editModel(row.id,{inputModalities:event.target.checked?['text','image']:['text']})}),
              type==='text'?'文字':'图片')),
            h('label',null,h('input',{type:'checkbox',disabled,checked:row.fast===true,onChange:event=>editModel(row.id,{fast:event.target.checked})}),'Fast')),
          !row.inputModalities?h('small',null,'图片能力未声明，当前按文字处理。'):null,
          h('div',{className:'ci-inline'},h('button',{type:'button',disabled,
            onClick:()=>{change({models:config.models.filter(model=>model.id!==row.id)});setExpandedModel(null);}},'移除')),
          ]:[])));
      }),
      ]:[]))),
      notice?h('p',{className:'ci-note ci-notice',role:'status'},h(Icon,{name:/失败|须|请输入|不能为空/.test(notice)?'warning':notice==='配置已保存。'?'check':'info'}),notice):null,
      h('footer',{className:'ci-inline ci-footer'},
        h('button',{type:'submit',className:'ci-primary',disabled},h(Icon,{name:busy?'refresh':'check'}),busy?'处理中…':'保存并启用此账号'),
        h('button',{type:'button',disabled:busy,onClick:()=>{setDraft(null);setKey('');setSelected(null);setCatalog([]);setNotice('');}},'取消修改')));
  }
  ctx.inject(['configForms','remote.cursorIntegrationUsage'],child=>{
    const forms=child.configForms;
    child.effect(()=>forms.whileServed(['cursor-integration'],()=>{
      const bundle=child.slots.inject('plugins.bundle.config',()=>child.slots.register({
        name:'plugins.bundle.config',key:'dsh-cursor-integration',
      },props=>h(Panel,{...props,scope:forms.get('cursor-integration'),compactionApi:child.remote.cursorIntegrationUsage})));
      let section, icon;
      try {
        section=child.slots.inject('settings.section',()=>child.slots.register({
          name:'settings.section',id:sectionId,order:24,label:()=> 'Cursor 集成',
        },props=>h(Panel,{...props,scope:forms.get('cursor-integration'),compactionApi:child.remote.cursorIntegrationUsage,view:'editor'})));
        icon=child.slots.inject('settings.section.icon',()=>child.slots.register({
          name:'settings.section.icon',id:sectionId,
        },({size})=>h(Icon,{name:'model',size})));
      }
      catch(error){section?.();bundle();throw error;}
      return ()=>{icon();section();bundle();};
    }));
  });
}
