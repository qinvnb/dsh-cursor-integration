// Ordinary (non-volatile) native configuration must go through ConfigEditor, not SettingsForms.
export function compactionSettings(editor) {
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
    }catch{return {...get(),error:'保存失败；请确认阈值高于保留比例，且配置允许写入。'};}
  }
  return {get,set};
}
