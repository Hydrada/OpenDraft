import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyMarkups, validateMarkups } from '../apps/opendraft/src/annotations.ts';
const time='2026-10-21T12:00:00.000Z';
const mark=(kind='callout',extra={})=>({id:kind,pageIndex:0,kind,points:[[150,150],[300,220]],...(kind==='callout'?{callout:[[40,60],[100,185],[150,185]]}:{}),color:[0.8,0,0],width:2,opacity:0.6,contents:'Review pipe',author:'Engineer',status:'open',locked:false,createdAt:time,modifiedAt:time,...extra});
async function base(){const p=await PDFDocument.create();p.setTitle('Preserved title');p.addPage([400,400]);return p.save();}
const nums=(d,key)=>d.lookup(PDFName.of(key),PDFArray).asArray().map(v=>v.asNumber());
async function pixels(bytes){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{const page=await(await task.promise).getPage(1),viewport=page.getViewport({scale:1}),canvas=createCanvas(400,400);await page.render({canvas,viewport}).promise;return canvas.getContext('2d').getImageData(0,0,400,400).data;}finally{await task.destroy();}}
test('callout CL/RD and cloud BE describe standard annotations and explicit appearances',async()=>{
 const bytes=await base(),before=bytes.slice(),input=[mark(),mark('cloud',{points:[[50,270],[250,350]]})],saved=await applyMarkups(bytes,input),p=await PDFDocument.load(saved),a=p.getPage(0).node.Annots(),call=p.context.lookup(a.get(0),PDFDict),cloud=p.context.lookup(a.get(1),PDFDict);
 assert.equal(call.lookup(PDFName.of('Subtype')).toString(),'/FreeText');assert.equal(call.lookup(PDFName.of('IT')).toString(),'/FreeTextCallout');assert.equal(call.lookup(PDFName.of('LE')).toString(),'/OpenArrow');assert.deepEqual(nums(call,'CL'),[40,60,100,185,150,185]);
 const rect=nums(call,'Rect'),rd=nums(call,'RD');assert.deepEqual([rect[0]+rd[0],rect[1]+rd[1],rect[2]-rd[2],rect[3]-rd[3]],[150,150,300,220]);assert.ok(rect[0]<40&&rect[1]<60);
 assert.equal(cloud.lookup(PDFName.of('Subtype')).toString(),'/Square');const be=cloud.lookup(PDFName.of('BE'),PDFDict);assert.equal(be.lookup(PDFName.of('S')).toString(),'/C');assert.equal(be.lookup(PDFName.of('I'),PDFNumber).asNumber(),1);
 for(const d of [call,cloud]) {
  const ap=d.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N'));
  const commands=new TextDecoder().decode(decodePDFRawStream(ap).decode());
  assert.match(commands,/\/GS0 gs/);
  const gs=ap.dict.lookup(PDFName.of('Resources'),PDFDict).lookup(PDFName.of('ExtGState'),PDFDict).lookup(PDFName.of('GS0'),PDFDict);assert.equal(gs.lookup(PDFName.of('CA'),PDFNumber).asNumber(),0.6);assert.equal(gs.lookup(PDFName.of('ca'),PDFNumber).asNumber(),0.6);
  if(d===cloud) { assert.ok((commands.match(/ c\n/g)??[]).length>=20);assert.match(commands,/h S/); }
  else { assert.match(commands,/1 0 0 1 124 154 Tm/);assert.match(commands,/120 100 150 70 re S/); }
 }
 assert.equal(p.getTitle(),'Preserved title');assert.deepEqual(bytes,before);assert.deepEqual(input,[mark(),mark('cloud',{points:[[50,270],[250,350]]})]);
});
test('leader schema rejects invalid, misplaced and out-of-page geometry and encoding',async()=>{
 for(const callout of [undefined,[],[[1,1]],[[1,1],[1,1]],[[1,1],[200,180]],[[1,1],[Infinity,150]],[[1,1],[2,2],[3,3],[150,180]]])assert.throws(()=>validateMarkups([mark('callout',{callout})],1));
 assert.throws(()=>validateMarkups([mark('cloud',{callout:[[1,1],[2,2]]})],1));assert.throws(()=>validateMarkups([mark('cloud',{points:[[20,20],[20,40]]})],1));assert.throws(()=>validateMarkups([mark('callout',{contents:'🛠'})],1));
 const bytes=await base();await assert.rejects(applyMarkups(bytes,[mark('callout',{callout:[[-1,20],[150,185]]})]),/outside/);await assert.rejects(applyMarkups(bytes,[mark('callout',{points:[[150,150],[160,155]],callout:[[50,50],[150,150]]})]),/too small/);
 const source=mark(),copy=validateMarkups([source],1)[0];copy.callout[0][0]=999;assert.equal(source.callout[0][0],40);
});
test('two-point leaders and reversed textbox corners work; flatten matches annotated pixels',async()=>{
 const bytes=await base(),marks=[mark('callout',{points:[[300,220],[150,150]],callout:[[40,60],[150,185]]}),mark('cloud',{points:[[50,270],[250,350]]})],annotated=await applyMarkups(bytes,marks),flat=await applyMarkups(bytes,marks,{flatten:true});
 const a=await pixels(annotated),b=await pixels(flat);let diff=0;for(let i=0;i<a.length;i++)diff+=Math.abs(a[i]-b[i]);assert.ok(diff/a.length<0.2,`mean channel difference ${diff/a.length}`);assert.ok(a.some((v,i)=>i%4!==3&&v<100));
 const p=await PDFDocument.load(flat);assert.equal(p.getPage(0).node.Annots()?.size()??0,0);assert.equal(p.getTitle(),'Preserved title');
 const existing=await applyMarkups(bytes,[mark('cloud',{id:'existing'})]),appended=await PDFDocument.load(await applyMarkups(existing,[mark()],{flatten:true}));assert.equal(appended.getPage(0).node.Annots().size(),1);
});
