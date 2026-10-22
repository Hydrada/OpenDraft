/** Authorized synthetic fixtures; outputs stay outside the source tree by default. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,degrees,rgb} from 'pdf-lib';

const folder=path.resolve(process.argv[2]??path.join(os.tmpdir(),'opendraft-revision-validation'));
await mkdir(folder,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(process.argv.includes('--compare')){
  const {compareRasters}=await import('../apps/opendraft/src/revision-comparison.ts');
  const manifest=JSON.parse(await readFile(path.join(folder,'rasters.json'),'utf8'));
  const results=[];
  for(const item of manifest.cases){
    const load=async id=>{const raster=manifest.rasters[id];return {width:raster.width,height:raster.height,data:new Uint8ClampedArray(await readFile(path.join(folder,raster.file)))};};
    const base=await load(item.base),revision=await load(item.revision);
    const before=[hash(base.data),hash(revision.data)];
    const result=compareRasters(base,revision,item.options);
    const overlayFile=`${item.id}-overlay.rgba`,differenceFile=`${item.id}-difference.rgba`;
    await writeFile(path.join(folder,overlayFile),result.overlay);
    await writeFile(path.join(folder,differenceFile),result.difference);
    const {overlay,difference,...metadata}=result;
    results.push({id:item.id,...metadata,overlayFile,differenceFile,inputHashesBefore:before,inputHashesAfter:[hash(base.data),hash(revision.data)]});
  }
  await writeFile(path.join(folder,'engine-results.json'),JSON.stringify(results,null,2));
  console.log(`Compared ${results.length} independent raster cases in ${folder}`);
}else{
  async function pdf(name,{empty=false,addition=false,shift=false,rotated=false,cropped=false}={}){
    const doc=await PDFDocument.create({updateMetadata:false});
    const page=doc.addPage(cropped?[160,140]:[120,100]);
    if(cropped)page.setCropBox(20,20,120,100);
    if(rotated)page.setRotation(degrees(180));
    if(!empty){
      const x=rotated?80:cropped?40:shift?28:20;
      const y=rotated?60:cropped?40:shift?15:20;
      page.drawRectangle({x,y,width:20,height:20,color:rgb(0,0,0)});
    }
    if(addition)page.drawRectangle({x:70,y:60,width:10,height:10,color:rgb(0,0,0)});
    const bytes=await doc.save();await writeFile(path.join(folder,`${name}.pdf`),bytes);
    return {file:`${name}.pdf`,sha256:hash(bytes)};
  }
  const documents={
    base:await pdf('base'),identical:await pdf('identical'),added:await pdf('added',{addition:true}),
    removed:await pdf('removed',{empty:true}),shifted:await pdf('shifted',{shift:true}),
    rotated:await pdf('rotated',{rotated:true}),cropped:await pdf('cropped',{cropped:true}),
  };
  const cases=[
    {id:'identical',base:'base',revision:'identical',options:{offsetX:0,offsetY:0,threshold:0},expectedChanged:0,expectedBounds:null},
    {id:'addition',base:'base',revision:'added',options:{offsetX:0,offsetY:0,threshold:0},expectedChanged:100,expectedBounds:{x:70,y:30,width:10,height:10}},
    {id:'removal',base:'base',revision:'removed',options:{offsetX:0,offsetY:0,threshold:0},expectedChanged:400,expectedBounds:{x:20,y:60,width:20,height:20}},
    {id:'unregistered',base:'base',revision:'shifted',options:{offsetX:0,offsetY:0,threshold:0},expectedChanged:440,expectedBounds:{x:20,y:60,width:28,height:25}},
    {id:'registered',base:'base',revision:'shifted',options:{offsetX:-8,offsetY:-5,threshold:0},expectedChanged:0,expectedBounds:null},
    {id:'rotation',base:'base',revision:'rotated',options:{offsetX:0,offsetY:0,threshold:0},expectedChanged:0,expectedBounds:null},
    {id:'crop',base:'base',revision:'cropped',options:{offsetX:0,offsetY:0,threshold:0},expectedChanged:0,expectedBounds:null},
    {id:'threshold-max',base:'base',revision:'removed',options:{offsetX:0,offsetY:0,threshold:255},expectedChanged:0,expectedBounds:null},
  ];
  await writeFile(path.join(folder,'fixtures.json'),JSON.stringify({documents,cases,renderScale:1},null,2));
  console.log(`Created ${Object.keys(documents).length} PDFs and ${cases.length} comparison cases in ${folder}`);
}
