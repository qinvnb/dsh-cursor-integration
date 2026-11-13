import test from 'node:test';
import assert from 'node:assert/strict';
import {positionPopup} from './client/popup-position.js';

test('a tall popup stays above the composer with a scrollable height instead of flipping below',()=>{
 const panel={style:{},offsetWidth:340,get offsetHeight(){return Math.min(350,parseFloat(this.style.maxHeight));}};
 positionPopup(panel,{left:340,right:465,top:300,bottom:326},{innerWidth:1000,innerHeight:760});
 assert.equal(panel.style.maxHeight,'280px');assert.equal(panel.style.top,'12px');
 assert.equal(parseFloat(panel.style.top)+panel.offsetHeight,292);
});

test('popup remains in the viewport near either horizontal edge and near the top',()=>{
 for(const anchor of [{left:0,right:80,top:300,bottom:326},{left:300,right:360,top:300,bottom:326},{left:50,right:150,top:20,bottom:46}]){
  const panel={style:{},offsetWidth:340,get offsetHeight(){return Math.min(200,parseFloat(this.style.maxHeight));}};
  positionPopup(panel,anchor,{innerWidth:375,innerHeight:700});
  assert.ok(parseFloat(panel.style.left)>=12);assert.ok(parseFloat(panel.style.left)+panel.offsetWidth<=363);
  assert.ok(parseFloat(panel.style.top)>=12);assert.ok(parseFloat(panel.style.top)+panel.offsetHeight<=688);
 }
});
