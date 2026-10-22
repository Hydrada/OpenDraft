import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeDifferenceClouds} from '../apps/opendraft/src/difference-clouds.ts';
import {compareRasters} from '../apps/opendraft/src/revision-comparison.ts';

function raster(width,height,points=[]){const data=new Uint8ClampedArray(width*height*4).fill(255);for(const [x,y] of points){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}return {width,height,data};}
const compare=(w,h,points)=>compareRasters(raster(w,h),raster(w,h,points),{offsetX:0,offsetY:0,threshold:16});
const geometry=(w,h)=>({width:w,height:h,transform:[1,0,0,-1,0,h],viewBox:[0,0,w,h]});
const options={minPixels:1,paddingPixels:0};

test('eight-connected regions have deterministic bounds, exact pixel counts and detached source storage',()=>{
  const input=compare(10,8,[[2,1],[3,1],[3,2],[6,5],[7,6]]),before=input.difference.slice();
  const found=proposeDifferenceClouds(input,geometry(10,8),options);
  assert.deepEqual(found,{smallRegions:0,outsideRegions:0,regions:[{id:1,changedPixels:3,rasterBounds:{x:2,y:1,width:2,height:2},pdfBounds:[2,5,4,7],clipped:false},{id:2,changedPixels:2,rasterBounds:{x:6,y:5,width:2,height:2},pdfBounds:[6,1,8,3],clipped:false}]});
  assert.deepEqual(input.difference,before);
  assert.equal(proposeDifferenceClouds(input,geometry(10,8),{minPixels:3,paddingPixels:1}).smallRegions,1);
  assert.deepEqual(proposeDifferenceClouds(compare(5,5,[]),geometry(5,5),options).regions,[]);
});

test('negative union origins, off-page exclusion, clipping and padding preserve the base coordinate system',()=>{
  const input=compare(10,8,[[0,0],[2,1],[3,2],[8,5]]);input.originX=-3;input.originY=-2;
  const found=proposeDifferenceClouds(input,geometry(6,4),{minPixels:1,paddingPixels:1});
  assert.equal(found.outsideRegions,1);assert.equal(found.regions.length,2);
  assert.deepEqual(found.regions[0],{id:1,changedPixels:2,rasterBounds:{x:3,y:2,width:2,height:2},pdfBounds:[0,2,2,4],clipped:true});
  assert.deepEqual(found.regions[1].pdfBounds,[4,0,6,2]);
  // Entirely outside changes stay excluded even if their margin intersects the page.
  const outside=compare(2,2,[[0,0]]);outside.originX=-1;
  assert.equal(proposeDifferenceClouds(outside,geometry(2,2),{minPixels:1,paddingPixels:5}).outsideRegions,1);
});

test('quarter turns, nonzero crop origins and physical UserUnit scale map to known PDF rectangles',()=>{
  const input=compare(10,8,[[2,2],[3,3]]);
  const cases=[
    {transform:[2,0,0,-2,-40,36],viewBox:[20,14,25,18],expected:[21,16,22,17]},
    {transform:[0,2,2,0,-20,-40],viewBox:[20,10,24,15],expected:[21,11,22,12]},
    {transform:[-2,0,0,2,50,-28],viewBox:[20,14,25,18],expected:[23,15,24,16]},
    {transform:[0,-2,-2,0,30,48],viewBox:[20,10,24,15],expected:[22,13,23,14]},
  ];
  for(const {transform,viewBox,expected} of cases)assert.deepEqual(proposeDifferenceClouds(input,{width:10,height:8,transform,viewBox},options).regions[0].pdfBounds,expected);
});

test('oversized, malformed, singular or noisy inputs reject without partial proposals',()=>{
  const valid=compare(4,4,[[1,1]]),base=geometry(4,4);
  for(const input of [{...valid,width:8193},{...valid,difference:new Uint8ClampedArray(1)},{...valid,originX:0.5}])assert.throws(()=>proposeDifferenceClouds(input,base,options));
  for(const transform of [[1,2],[1,0,0,0,0,0],[NaN,0,0,1,0,0]])assert.throws(()=>proposeDifferenceClouds(valid,{...base,transform},options));
  for(const setting of [{minPixels:0,paddingPixels:1},{minPixels:1.5,paddingPixels:0},{minPixels:1,paddingPixels:145},{minPixels:1,paddingPixels:NaN}])assert.throws(()=>proposeDifferenceClouds(valid,base,setting));
  const bad={...valid,difference:valid.difference.slice()};bad.difference[0]=123;assert.throws(()=>proposeDifferenceClouds(bad,base,options),/unsupported/);
  const noise=compare(403,1,Array.from({length:201},(_,i)=>[i*2,0]));
  assert.throws(()=>proposeDifferenceClouds(noise,geometry(403,1),options),/More than 200/);
  assert.equal(proposeDifferenceClouds(noise,geometry(403,1),{minPixels:2,paddingPixels:0}).smallRegions,201);
});
