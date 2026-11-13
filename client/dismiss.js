// Native details needs explicit light-dismiss behavior when used as a popup.
export function attachContextDismiss(root) {
  const document=root.ownerDocument;
  function close(event) {
    if(event.type==='keydown') {
      if(event.key!=='Escape')return;
      root.open=false;
      event.preventDefault();
      root.querySelector('summary')?.focus({preventScroll:true});
    } else if(!root.contains(event.target))root.open=false;
    if(!root.open)listen(false);
  }
  function listen(enabled) {
    const method=enabled?'addEventListener':'removeEventListener';
    for(const type of ['pointerdown','focusin','keydown'])document[method](type,close,true);
  }
  const toggle=()=>listen(root.open);
  root.addEventListener('toggle',toggle);
  toggle();
  return ()=>{root.removeEventListener('toggle',toggle);listen(false);};
}
