import {COMPARISON_COLORS, COMPARISON_LIMITS, type RasterComparison} from './revision-comparison.ts';

export type CloudRegion = {id:number;changedPixels:number;rasterBounds:{x:number;y:number;width:number;height:number};pdfBounds:[number,number,number,number];clipped:boolean};
export type CloudGeometry = {width:number;height:number;transform:readonly number[];viewBox:readonly number[]};
export type CloudOptions = {minPixels:number;paddingPixels:number};
export const DIFFERENCE_CLOUD_LIMITS=Object.freeze({maxRegions:200,maxMinPixels:1_000_000,maxPaddingPixels:144});

/** Eight-connected visual differences, with deterministic scan order. No semantic inference. */
export function proposeDifferenceClouds(input:RasterComparison,base:CloudGeometry,options:CloudOptions) {
  const {width,height,originX,originY,difference}=input;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>COMPARISON_LIMITS.maxSide||height>COMPARISON_LIMITS.maxSide||width*height>COMPARISON_LIMITS.maxPixels||!Number.isSafeInteger(originX)||!Number.isSafeInteger(originY)||!(difference instanceof Uint8ClampedArray)||difference.length!==width*height*4)throw new Error('Invalid or oversized difference raster.');
  if(!options||!Number.isSafeInteger(options.minPixels)||options.minPixels<1||options.minPixels>DIFFERENCE_CLOUD_LIMITS.maxMinPixels||!Number.isFinite(options.paddingPixels)||options.paddingPixels<0||options.paddingPixels>DIFFERENCE_CLOUD_LIMITS.maxPaddingPixels)throw new Error('Invalid difference-cloud size or padding.');
  if(!base||![base.width,base.height].every(v=>Number.isFinite(v)&&v>0&&v<=COMPARISON_LIMITS.maxSide)||!Array.isArray(base.transform)||base.transform.length!==6||!base.transform.every(Number.isFinite)||!Array.isArray(base.viewBox)||base.viewBox.length!==4||!base.viewBox.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e7)||base.viewBox[0]>=base.viewBox[2]||base.viewBox[1]>=base.viewBox[3])throw new Error('Invalid base page viewport geometry.');
  const [a,b,c,d,e,f]=base.transform,det=a*d-b*c;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw new Error('Base viewport transform is singular.');
  const pdfPoint=(x:number,y:number)=>[(d*(x-e)-c*(y-f))/det,(-b*(x-e)+a*(y-f))/det];
  const mask=new Uint8Array(width*height),queue=new Int32Array(width*height);
  const colors=Object.values(COMPARISON_COLORS);
  for(let p=0;p<mask.length;p++){
    const i=p*4;
    if(difference[i+3]!==255)throw new Error('Difference raster must be opaque.');
    if(colors.some(color=>difference[i]===color[0]&&difference[i+1]===color[1]&&difference[i+2]===color[2]))mask[p]=1;
    else if(difference[i]!==difference[i+1]||difference[i]!==difference[i+2]||difference[i]<224)throw new Error('Difference raster contains an unsupported comparison color.');
  }
  const regions:CloudRegion[]=[];let smallRegions=0,outsideRegions=0;
  for(let start=0;start<mask.length;start++){
    if(!mask[start])continue;
    let head=0,tail=1,minX=width,minY=height,maxX=-1,maxY=-1;queue[0]=start;mask[start]=0;
    while(head<tail){
      const p=queue[head++],x=p%width,y=Math.floor(p/width);
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;
        const n=ny*width+nx;if(mask[n]){mask[n]=0;queue[tail++]=n;}
      }
    }
    if(tail<options.minPixels){smallRegions++;continue;}
    // Clip the actual change bounds first; padding cannot pull an entirely off-page change onto the base.
    const raw=[minX+originX,minY+originY,maxX+1+originX,maxY+1+originY];
    if(raw[2]<=0||raw[3]<=0||raw[0]>=base.width||raw[1]>=base.height){outsideRegions++;continue;}
    const left=Math.max(0,raw[0]-options.paddingPixels),top=Math.max(0,raw[1]-options.paddingPixels),right=Math.min(base.width,raw[2]+options.paddingPixels),bottom=Math.min(base.height,raw[3]+options.paddingPixels);
    const points=[pdfPoint(left,top),pdfPoint(right,top),pdfPoint(right,bottom),pdfPoint(left,bottom)];
    const bounds:[number,number,number,number]=[Math.max(base.viewBox[0],Math.min(...points.map(p=>p[0]))),Math.max(base.viewBox[1],Math.min(...points.map(p=>p[1]))),Math.min(base.viewBox[2],Math.max(...points.map(p=>p[0]))),Math.min(base.viewBox[3],Math.max(...points.map(p=>p[1])))];
    if(!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3])throw new Error('Difference region cannot be mapped to the base page.');
    if(regions.length>=DIFFERENCE_CLOUD_LIMITS.maxRegions)throw new Error('More than 200 difference regions. Increase minimum pixels or review alignment and threshold; no partial proposal retained.');
    regions.push({id:regions.length+1,changedPixels:tail,rasterBounds:{x:left-originX,y:top-originY,width:right-left,height:bottom-top},pdfBounds:bounds,clipped:raw[0]<0||raw[1]<0||raw[2]>base.width||raw[3]>base.height});
  }
  return {regions,smallRegions,outsideRegions};
}
