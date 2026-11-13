export function positionPopup(panel,anchor,view) {
  const edge=12,gap=8;
  const above=Math.max(0,anchor.top-gap-edge);
  const below=Math.max(0,view.innerHeight-anchor.bottom-gap-edge);
  const useAbove=above>=100||above>=below;
  panel.style.maxHeight=Math.max(1,useAbove?above:below)+'px';
  panel.style.left=Math.max(edge,Math.min(view.innerWidth-panel.offsetWidth-edge,
    (anchor.left+anchor.right-panel.offsetWidth)/2))+'px';
  panel.style.top=(useAbove?Math.max(edge,anchor.top-gap-panel.offsetHeight):anchor.bottom+gap)+'px';
}
