import React from 'react';

// A single stroke style for settings headings, actions and conversation status.
const paths = {
  account:['M20 21v-2a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v2','M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8'],
  key:['M15 3a6 6 0 1 0 4 10l3-3-2-2-2 2-2-2 2-2-2-3Z'],
  network:['M12 3v6M5 21v-6h14v6M12 15V9M8 3h8v6H8Z','M2 21h6M16 21h6'],
  clock:['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18','M12 7v5l3 2'],
  model:['M12 2 3 7v10l9 5 9-5V7L12 2Z','m3 7 9 5 9-5M12 12v10'],
  refresh:['M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5','M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5'],
  check:['m5 12 4 4L19 6'],
  warning:['m12 3 10 18H2L12 3Z','M12 9v5M12 17h.01'],
  compress:['M4 4h6v6H4ZM14 14h6v6h-6Z','m15 9 5-5M15 4h5v5M9 15l-5 5M4 15v5h5'],
  checkpoint:['M6 3h10l3 3v15H5V3h1Z','M8 3v6h8V3M8 21v-7h8v7'],
  chart:['M4 3v18h17','M8 16v-5M13 16V7M18 16v-8'],
  plus:['M12 5v14M5 12h14'],
  trash:['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
  search:['M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15','m16 16 5 5'],
  info:['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18','M12 11v6M12 7h.01'],
};
export function Icon({name,size=16,...props}) {
  return React.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,...props},
    ...(paths[name]??paths.info).map((d,i)=>React.createElement('path',{key:i,d})));
}
