import {editDesktopCompaction,isPendingCompactionConflict} from './compaction-profile.js';

// Ordinary (non-volatile) native configuration must go through ConfigEditor, not SettingsForms.
export function compactionSettings(editor, root) {
  const locate=()=>editor?.configuration().find(row=>row.entry.options.id==='compaction-basic');
  function get(){
    const row=locate();
    if(!row)return {available:false,error:'DSH 原生压缩配置暂不可用。'};
    const config={...row.inherited,...row.override};
    const threshold=config.thresholdRatio??0.8;
    if(typeof threshold!=='number'||!Number.isFinite(threshold))return {available:false,error:'压缩阈值使用动态配置，无法在此编辑。'};
    return {available:true,thresholdRatio:threshold};
  }
  async function set(ratio){
    if(!Number.isFinite(ratio)||ratio<=0||ratio>1)return {available:false,error:'请输入大于 0、不超过 1 的比例。'};
    const row=locate();
    if(!row)return {available:false,error:'DSH 原生压缩配置暂不可用。'};
    try{
      await editor.edit(row.entry,current=>({...current,thresholdRatio:ratio}));
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
