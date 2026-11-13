import React from 'react';
import {attachContextDismiss} from './dismiss.js';
import {positionPopup} from './popup-position.js';
const h=React.createElement;
const styles=`
.ci-popup{display:inline-flex;min-width:0;max-width:100%;font:inherit;color:inherit}
.ci-popup>summary{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:26px;box-sizing:border-box;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:inherit;font:inherit;font-variant-numeric:tabular-nums;cursor:pointer;list-style:none}
.ci-popup>summary::-webkit-details-marker{display:none}.ci-popup>summary:hover,.ci-popup[open]>summary{background:var(--dsw-alias-interactive-bg-hover)}.ci-popup>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.ci-popup>summary svg{flex:none;width:16px;height:16px}
.ci-popup-panel{position:fixed;inset:auto;margin:0;z-index:1000;width:340px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;box-sizing:border-box;padding:14px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 6px 24px #0002;font-size:12px;line-height:20px;text-align:left}
.ci-popup-heading{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;margin-bottom:8px}.ci-popup-heading svg{flex:none;color:var(--dsw-alias-label-secondary)}
.ci-popup-options{display:grid;gap:4px;margin-top:8px}.ci-popup-option{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.ci-popup-option:hover,.ci-popup-option[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}.ci-popup-option:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.ci-popup-option:disabled{opacity:.5;cursor:default}.ci-popup-option>svg{flex:none}.ci-popup-option>span{flex:1;min-width:0;overflow-wrap:anywhere}
.ci-popup-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:5px 0}.ci-popup-row>span:first-child{color:var(--dsw-alias-label-secondary)}.ci-popup-row>span:last-child{font-variant-numeric:tabular-nums;overflow-wrap:anywhere;text-align:right}.ci-popup-note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.ci-popup-action{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:var(--dsw-radius-sm,4px);padding:4px 6px;margin-top:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.ci-popup-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
`;
export function Popup({label,trigger,children}) {
  const root=React.useRef(null);
  React.useEffect(()=>{
    const element=root.current;
    if(!element)return;
    const cleanup=attachContextDismiss(element);
    const document=element.ownerDocument,view=document.defaultView;
    const panel=element.querySelector('.ci-popup-panel');
    const position=()=>{
      if(!element.open)return;
      positionPopup(panel,element.querySelector('summary').getBoundingClientRect(),view);
    };
    const toggle=()=>{
      if(element.open) {
        if(!panel.matches(':popover-open'))panel.showPopover();
      } else if(panel.matches(':popover-open'))panel.hidePopover();
      const method=element.open?'addEventListener':'removeEventListener';
      view[method]('resize',position);
      document[method]('scroll',position,true);
      position();
    };
    element.addEventListener('toggle',toggle);
    return ()=>{cleanup();if(panel.matches(':popover-open'))panel.hidePopover();element.removeEventListener('toggle',toggle);view.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);};
  },[]);
  return h('details',{ref:root,className:'ci-popup',name:'cursor-integration-popup'},
    h('style',null,styles),
    h('summary',{'aria-label':label},trigger),
    h('div',{className:'ci-popup-panel',popover:'manual'},typeof children==='function'?children(()=>{
      if(root.current){root.current.open=false;root.current.querySelector('summary')?.focus({preventScroll:true});}
    }):children));
}
