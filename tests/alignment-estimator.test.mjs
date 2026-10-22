import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {estimateAlignment, ALIGNMENT_LIMITS} from '../apps/opendraft/src/alignment-estimator.ts';

function drawing() {
  const width = 512, height = 448, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x, y, value = 0) => {if(x >= 0 && y >= 0 && x < width && y < height){const p=(Math.round(y)*width+Math.round(x))*4;data[p]=data[p+1]=data[p+2]=value;}};
  const rectangle = (x, y, w, h, value = 0) => {for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)ink(xx,yy,value);};
  for(let j=0;j<5;j++)for(let i=0;i<6;i++){
    const n=j*6+i,x=35+i*76,y=35+j*76;
    rectangle(x,y,18+n%7,3);rectangle(x,y,3,20+n%13);
    rectangle(x+12,y+12,4+(n*7)%18,5+(n*11)%17,40+(n*13)%80);
    for(let k=0;k<17;k++)ink(x+20+k,y+25+Math.round(Math.sin((k+n)*0.3)*7));
    rectangle(x+30+(n%4),y+2,3,4+(n*5)%19);
    for(let k=0;k<n%5+1;k++)rectangle(x+4*k,y+42,2,3+(n+k)%8);
  }
  return {width,height,data};
}
function transformed(base, matrix, addChanges=false) {
  const {width,height}=base,data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const bx=Math.floor(matrix[0]*(x+0.5)+matrix[2]*(y+0.5)+matrix[4]);
    const by=Math.floor(matrix[1]*(x+0.5)+matrix[3]*(y+0.5)+matrix[5]);
    if(bx>=0&&by>=0&&bx<width&&by<height)data.set(base.data.subarray((by*width+bx)*4,(by*width+bx)*4+4),(y*width+x)*4);
  }
  if(addChanges)for(let y=170;y<205;y++)for(let x=240;x<305;x++){const p=(y*width+x)*4;data[p]=data[p+1]=data[p+2]=255;}
  return {width,height,data};
}
function similarity(degrees,scale,e,f){const angle=degrees*Math.PI/180,a=scale*Math.cos(angle),b=scale*Math.sin(angle);return[a,b,-b,a,e,f];}
function maxLandmarkError(actual,expected){
  return Math.max(...[[50,50],[450,50],[50,390],[450,390],[256,224]].map(([x,y])=>Math.hypot((actual[0]-expected[0])*x+(actual[2]-expected[2])*y+actual[4]-expected[4],(actual[1]-expected[1])*x+(actual[3]-expected[3])*y+actual[5]-expected[5])));
}
const hash=page=>createHash('sha256').update(page.data).digest('hex');

test('identical distinctive sheets yield identity with independent spatial support and immutable inputs',async()=>{
  const base=drawing(),revision=structuredClone(base),before=[hash(base),hash(revision)];
  const result=await estimateAlignment(base,revision);
  assert.ok(maxLandmarkError(result.matrix,[1,0,0,1,0,0])<1e-8);
  assert.ok(result.inliers>=8);assert.ok(result.inliers/result.matches>=0.45);assert.ok(result.coverage>=0.08);
  assert.equal(result.scale,1);assert.equal(result.rotationDegrees,0);assert.equal(result.residualPixels,0);
  assert.deepEqual([hash(base),hash(revision)],before);
});

test('translation, rotation, scale and combined similarity recover known landmark locations despite local revisions',async()=>{
  const base=drawing();
  const matrices=[[1,0,0,1,-13,9],similarity(8,1,25,-30),similarity(0,0.9,28,20),similarity(-9,1.1,-50,15)];
  for(const matrix of matrices){
    const revision=transformed(base,matrix,true),before=hash(revision),result=await estimateAlignment(base,revision);
    assert.ok(maxLandmarkError(result.matrix,matrix)<3,`landmarks outside3px: ${JSON.stringify(result)}`);
    assert.ok(Math.abs(result.scale-Math.hypot(matrix[0],matrix[1]))<0.015);
    assert.ok(Math.abs(result.rotationDegrees-Math.atan2(matrix[1],matrix[0])*180/Math.PI)<0.5);
    assert.equal(hash(revision),before);assert.ok(result.residualPixels<3);
  }
});

test('estimates are deterministic for repeated feature matches and use outer-edge pixel center coordinates',async()=>{
  const base=drawing(),matrix=[0,1,-1,0,480,-24],revision=transformed(base,matrix);
  const a=await estimateAlignment(base,revision),b=await estimateAlignment(base,revision);
  assert.deepEqual(a,b);assert.ok(maxLandmarkError(a.matrix,matrix)<3);
});

test('blank, transparent, unrelated and small drawings are refused rather than fabricated as identity',async()=>{
  const base=drawing(),blank={width:512,height:448,data:new Uint8ClampedArray(512*448*4).fill(255)};
  await assert.rejects(estimateAlignment(base,blank),/features|alignment/);
  const transparent=structuredClone(base);for(let i=3;i<transparent.data.length;i+=4)transparent.data[i]=0;
  await assert.rejects(estimateAlignment(base,transparent),/features|alignment/);
  const unrelated=structuredClone(blank);
  for(let y=20;y<428;y++)for(let x=20;x<492;x++)if((x+y)%23<2){const p=(y*512+x)*4;unrelated.data[p]=unrelated.data[p+1]=unrelated.data[p+2]=0;}
  await assert.rejects(estimateAlignment(base,unrelated),/features|alignment/);
  await assert.rejects(estimateAlignment({width:32,height:32,data:new Uint8ClampedArray(4096)},base),/features|alignment/);
});

test('input geometry and storage limits reject before reading invalid or oversized raster bytes',async()=>{
  const valid=drawing();
  const oversized={width:2001,height:2000,get data(){throw new Error('bytes accessed');}};
  await assert.rejects(estimateAlignment(oversized,valid),/budget/);
  for(const width of [0,-1,1.1,NaN,Infinity,8193])await assert.rejects(estimateAlignment({width,height:1,data:new Uint8ClampedArray(4)},valid),/budget|dimensions/);
  await assert.rejects(estimateAlignment({...valid,data:new Uint8Array(valid.data)},valid),/RGBA/);
  await assert.rejects(estimateAlignment({...valid,data:new Uint8ClampedArray(3)},valid),/RGBA/);
  assert.equal(ALIGNMENT_LIMITS.maxFeatures,600);assert.equal(ALIGNMENT_LIMITS.previewSide,640);
});
