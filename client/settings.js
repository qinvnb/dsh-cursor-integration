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
.ci-settings small{color:var(--dsw-alias-label-tertiary)}.ci-settings button{cursor:pointer}.ci-settings button:disabled{opacity:.5;cursor:default}
.ci-settings button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.ci-settings .ci-primary{background:var(--dsw-alias-state-business-primary);color:white}.ci-settings .ci-primary:hover:enabled{filter:brightness(.95);background:var(--dsw-alias-state-business-primary)}.ci-settings .ci-error{color:var(--dsw-alias-state-error-primary)}
`;
const heading=(name,label)=>h('h3',null,h(Icon,{name}),label);
const note=text=>h('p',{className:'ci-note'},h(Icon,{name:'info'}),text);
function modelRow(row) {return typeof row==='string'?{id:row}:structuredClone(row);}
export function mountSettings(ctx) {
  function Panel({scope,view}) {
    const snapshot=React.useSyncExternalStore(fn=>scope.subscribe(fn),()=>scope.getSnapshot());
    const [draft,setDraft]=React.useState(null);
    const [key,setKey]=React.useState('');
    const [notice,setNotice]=React.useState('');
    const [busy,setBusy]=React.useState(false);
    const [catalog,setCatalog]=React.useState([]);
    const [query,setQuery]=React.useState('');
    const [proxyUrl,setProxyUrl]=React.useState(null);
    const [selected,setSelected]=React.useState(null);
    const [accountMenuOpen,setAccountMenuOpen]=React.useState(false);
    const accountButton=React.useRef(null);
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
        const response=await ctx.remote.llm.discoverModels('cursor-integration',{
          provider:'cursor',...(key.trim()?{apiKey:key.trim()}:{}),
        });
        if(!response.ok)throw Error();
        setCatalog(response.value.filter(row=>!row.id.includes('@')));
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
          setNotice('上下文容量须为正整数 Token 数。');return;
        }
      }
      if(proxyUrl?.trim()){
        try{const parsed=new URL(proxyUrl);if(parsed.protocol!=='http:')throw Error();}
        catch{setNotice('代理地址须为 http:// 开头的 HTTP 或混合代理地址。');return;}
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
        if(proxyUrl!==null)operations.push({op:'set',path:['proxyUrl'],value:proxyUrl.trim()});
        const ok=await scope.mutate(operations,snapshot.revision);
        if(!ok)throw Error();
        setDraft(null);setProxyUrl(null);setNotice('配置已保存。');
      } catch {setNotice('保存失败，请刷新配置后重试。');}
      finally {setBusy(false);}
    }
    function addAccount() {
      const apiKeyEnv='CURSOR_INTEGRATION_'+crypto.randomUUID().replaceAll('-','').toUpperCase();
      change({accounts:[...config.accounts,{label:'新账号',apiKeyEnv,configured:false}]});
      setSelected(apiKeyEnv);setKey('');
    }
    return h('form',{className:'ci-settings',onSubmit:save},
      h('style',null,sheet),
      h('header',null,h('h2',null,'Cursor 集成'),h('p',{className:'ci-note'},'管理账号、连接和模型；账号用量与线路检测位于「Cursor 用量」。')),
      h('section',{className:'ci-section'},heading('key','账号与凭据'),
      h('div',{className:'ci-inline'},
        h(Menu,{open:accountMenuOpen,onClose:()=>setAccountMenuOpen(false),
          items:config.accounts.map(row=>({id:row.apiKeyEnv,label:row.label})),selectedId:ref,align:'start',portal:true,
          onSelect:id=>{accountButton.current?.focus({preventScroll:true});setSelected(id);setKey('');setAccountMenuOpen(false);},
          anchor:h('button',{ref:accountButton,type:'button',className:'ci-account-select',disabled,
            'aria-label':'选择配置账号','aria-haspopup':'menu','aria-expanded':accountMenuOpen,
            onClick:()=>setAccountMenuOpen(!accountMenuOpen)},h('span',null,account?.label??'选择账号'),h(IconChevronDownOutlineRegular,{'aria-hidden':true}))}),
        h('button',{type:'button',disabled,onClick:addAccount},h(Icon,{name:'plus'}),'添加账号'),
        h('button',{type:'button',disabled:disabled||config.accounts.length<2,onClick:()=>{
          const accounts=config.accounts.filter(row=>row.apiKeyEnv!==ref);
          change({accounts,apiKeyEnv:accounts[0].apiKeyEnv});setSelected(accounts[0].apiKeyEnv);setKey('');
        }},h(Icon,{name:'trash'}),'移除此账号')),
      h('div',{className:'ci-grid'},
      field('账号名称',{value:account?.label??'',onChange:event=>editAccount({label:event.target.value})}),
      field('Cursor API Key',{type:'password',autoComplete:'new-password',value:key,
        placeholder:account?.configured?'已保存，留空继续使用':'粘贴此账号的 API Key',
        onChange:event=>setKey(event.target.value)})),
      note('密钥保存在 DSH 凭据服务。保存后，新请求使用当前账号。')),
      h('section',{className:'ci-section'},heading('network','连接与刷新'),
      h('div',{className:'ci-grid'},
      field('Cursor SDK 代理地址',{placeholder:'http://127.0.0.1:7890',value:proxyUrl??snapshot.value?.proxyUrl??'',onChange:event=>setProxyUrl(event.target.value)}),
      field('后台用量刷新间隔（分钟）',{type:'number',min:1,max:1440,value:config.usageRefreshMinutes??5,
        onChange:event=>change({usageRefreshMinutes:event.target.value})})),
      note('代理只作用于 Cursor SDK 和相关查询；留空直连。用量在后台定时刷新，请求读取已保存的调度结果。')),
      h('section',{className:'ci-section'},heading('model','模型目录'),
      h('div',{className:'ci-inline'},
        h('button',{type:'button',disabled,onClick:discover},h(Icon,{name:'refresh'}),'获取模型目录'),
        h('button',{type:'button',disabled,onClick:()=>change({models:undefined})},'跟随账号全部模型')),
      field('搜索模型',{value:query,onChange:event=>setQuery(event.target.value)}),
      ...catalog.filter(row=>(row.name+' '+row.id).toLowerCase().includes(query.toLowerCase()))
        .filter(row=>!config.models?.some(saved=>saved.id===row.id)).map(row=>h('div',{key:row.id,className:'ci-inline'},
          h('span',null,row.name??row.id),
          h('button',{type:'button',disabled,onClick:()=>change({models:[...(config.models??[]),{id:row.id,name:'Cursor '+(row.name??row.id)}]})},'添加'))),
      ...(config.models??[]).filter(row=>(row.id+' '+(row.name??'')).toLowerCase().includes(query.toLowerCase())).map(row=>
        h('div',{key:row.id,className:'ci-model'},
          h('div',{className:'ci-inline'},h('strong',null,row.id),
            h('button',{type:'button',disabled,onClick:()=>change({models:config.models.filter(m=>m.id!==row.id)})},'移除')),
          field('显示名称',{value:row.name??'',onChange:event=>editModel(row.id,{name:event.target.value})}),
          field('上下文容量（Token）',{type:'number',min:1,value:row.contextWindow??'',
            onChange:event=>editModel(row.id,{contextWindow:event.target.value?Number(event.target.value):undefined})}),
          h('div',{className:'ci-inline'},
            ...['text','image'].map(type=>h('label',{key:type},
              h('input',{type:'checkbox',disabled:disabled||type==='text',checked:type==='text'||row.inputModalities?.includes('image')===true,
                onChange:event=>editModel(row.id,{inputModalities:event.target.checked?['text','image']:['text']})}),
              type==='text'?'文字':'图片')),
            h('label',null,h('input',{type:'checkbox',disabled,checked:row.fast===true,onChange:event=>editModel(row.id,{fast:event.target.checked})}),'Fast')),
          !row.inputModalities?h('small',null,'图片能力未声明，当前按文字处理。'):null)),
      !config.models?note('未指定模型列表时，跟随账号可用的全部模型。'):null),
      notice?h('p',{className:'ci-note ci-notice',role:'status'},h(Icon,{name:/失败|须|请输入|不能为空/.test(notice)?'warning':notice==='配置已保存。'?'check':'info'}),notice):null,
      h('footer',{className:'ci-inline ci-footer'},
        h('button',{type:'submit',className:'ci-primary',disabled},h(Icon,{name:busy?'refresh':'check'}),busy?'处理中…':'保存并启用此账号'),
        h('button',{type:'button',disabled:busy,onClick:()=>{setDraft(null);setKey('');setSelected(null);setProxyUrl(null);setNotice('');}},'取消修改')));
  }
  ctx.inject(['configForms'],child=>{
    const forms=child.configForms;
    child.effect(()=>forms.whileServed(['cursor-integration'],()=>{
      const bundle=child.slots.inject('plugins.bundle.config',()=>child.slots.register({
        name:'plugins.bundle.config',key:'dsh-cursor-integration',
      },props=>h(Panel,{...props,scope:forms.get('cursor-integration')})));
      let section;
      try {section=child.slots.inject('settings.section',()=>child.slots.register({
        name:'settings.section',id:'cursor-integration-api',order:24,label:()=> 'Cursor 集成',icon:()=>h(Icon,{name:'model'}),
      },props=>h(Panel,{...props,scope:forms.get('cursor-integration'),view:'editor'})));}
      catch(error){bundle();throw error;}
      return ()=>{section();bundle();};
    }));
  });
}
