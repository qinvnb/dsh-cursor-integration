import {editDesktopCompaction,isPendingCompactionConflict} from './compaction-profile.js';

export function isCompactionEntry(item){
  return Boolean(item && typeof item==='object' && (item.id==='compaction-basic'||item.name==='@deepseek-ai/dsh-compaction-basic') && !item.group);
}

export function collectNestedCompactionRatios(entries,out=[]){
  if(!Array.isArray(entries))return out;
  for(const item of entries){
    if(!item || typeof item!=='object')continue;
    if(isCompactionEntry(item)){
      const ratio=item.config?.thresholdRatio??0.8;
      if(typeof ratio==='number' && Number.isFinite(ratio))out.push(ratio);
      continue;
    }
    if(Array.isArray(item.config))collectNestedCompactionRatios(item.config,out);
    if(Array.isArray(item.plugins))collectNestedCompactionRatios(item.plugins,out);
  }
  return out;
}

export function patchNestedCompaction(entries,ratio){
  if(!Array.isArray(entries))return {changed:false,entries};
  let changed=false;
  const next=entries.map(item=>{
    if(!item || typeof item!=='object')return item;
    if(isCompactionEntry(item)){
      changed=true;
      return {...item,config:{...(item.config&&!Array.isArray(item.config)?item.config:{}),thresholdRatio:ratio}};
    }
    let updated=item;
    if(Array.isArray(item.config)){
      const sub=patchNestedCompaction(item.config,ratio);
      if(sub.changed){changed=true;updated={...updated,config:sub.entries};}
    }
    if(Array.isArray(item.plugins)){
      const sub=patchNestedCompaction(item.plugins,ratio);
      if(sub.changed){changed=true;updated={...updated,plugins:sub.entries};}
    }
    return updated;
  });
  return {changed,entries:changed?next:entries};
}

// Ordinary (non-volatile) native configuration must go through ConfigEditor, not SettingsForms.
export function compactionSettings(editor, root) {
  const locate=()=>editor?.configuration().find(row=>row.entry.options.id==='compaction-basic');
  const presetRows=()=>(editor?.configuration()??[]).filter(row=>{
    const config={...row.inherited,...row.override};
    return Array.isArray(config.plugins) && collectNestedCompactionRatios(config.plugins).length>0;
  });
  function get(){
    const row=locate();
    if(!row)return {available:false,error:'DSH 原生压缩配置暂不可用。'};
    const config={...row.inherited,...row.override};
    const threshold=config.thresholdRatio??0.8;
    if(typeof threshold!=='number'||!Number.isFinite(threshold))return {available:false,error:'压缩阈值使用动态配置，无法在此编辑。'};
    const presetMismatch=presetRows().some(preset=>{
      const cfg={...preset.inherited,...preset.override};
      return collectNestedCompactionRatios(cfg.plugins).some(ratio=>ratio!==threshold);
    });
    return {available:true,thresholdRatio:threshold,...(presetMismatch?{presetMismatch:true}:{})};
  }
  async function set(ratio){
    if(!Number.isFinite(ratio)||ratio<=0||ratio>1)return {available:false,error:'请输入大于 0、不超过 1 的比例。'};
    const row=locate();
    if(!row)return {available:false,error:'DSH 原生压缩配置暂不可用。'};
    try{
      await editor.edit(row.entry,current=>({...current,thresholdRatio:ratio}));
      for(const preset of presetRows()){
        await editor.edit(preset.entry,current=>{
          const base=current?.plugins?current:{...preset.inherited,...preset.override,...current};
          const patched=patchNestedCompaction(base.plugins,ratio);
          return patched.changed?{...base,plugins:patched.entries}:base;
        });
      }
      return get();
    }catch(error){
      if(root&&isPendingCompactionConflict(error)){
        try{
          await editDesktopCompaction(editor,root,ratio);
          return get();
        }catch(error){return {...get(),error:saveError(error)};}
      }
      return {...get(),error:saveError(error)};
    }
  }
  return {get,set};
}

function saveError(error){
  const message=String(error?.message??'');
  if(/retainRatio \([\d.]+\) must be less than the resolved thresholdRatio/.test(message))return '压缩阈值须高于当前的保留比例。';
  if(/waiting for the writer lock/.test(message))return 'DSH 配置正在被修改，请稍后重试。';
  if(/profile changed during save/.test(message))return 'DSH 配置刚刚发生变化，请重新打开设置后重试。';
  if(/another configuration|overridden by a home patch/.test(message))return '其他配置层覆盖了自动压缩阈值。';
  return 'DSH 未能保存压缩阈值，请重新打开设置后重试。';
}
