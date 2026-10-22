import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFHexString } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyMarkups, validateMarkups } from '../apps/opendraft/src/annotations.ts';

const time='2026-10-21T12:00:00.000Z';
const mark=(kind='rectangle',extra={})=>({id:kind,pageIndex:0,kind,points:[[50,50],[180,120]],color:[1,0,0],width:2,opacity:0.7,contents:'Review note',author:'Engineer',status:'open',locked:false,createdAt:time,modifiedAt:time,...extra});
async function base(){const pdf=await PDFDocument.create();pdf.setTitle('Synthetic annotation corpus');pdf.addPage([400,400]);return pdf.save();}
function load(bytes){return getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});}
async function pixels(bytes){const task=load(bytes);try{const pdf=await task.promise,page=await pdf.getPage(1),viewport=page.getViewport({scale:1}),canvas=createCanvas(viewport.width,viewport.height);await page.render({canvas,viewport}).promise;return new Uint8Array(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);}finally{await task.destroy();}}

test('standard annotation subtypes carry independent-reader appearances and metadata',async()=>{
  const bytes=await base(),before=bytes.slice();
  const kinds=['rectangle','ellipse','line','arrow','highlight','ink','text'];
  const output=await applyMarkups(bytes,kinds.map(kind=>mark(kind,kind==='ink'?{points:[[50,50],[90,90],[150,60]]}:{})));
  const task=load(output);
  try{
    const pdf=await task.promise,annotations=await(await pdf.getPage(1)).getAnnotations();
    assert.deepEqual(annotations.map(a=>a.subtype),['Square','Circle','Line','Line','Highlight','Ink','FreeText']);
    assert.ok(annotations.every(a=>a.hasAppearance&&a.contentsObj.str==='Review note'&&a.titleObj.str==='Engineer'));
    const arrow=annotations[3];assert.deepEqual(arrow.lineEndings,['None','OpenArrow']);
    assert.equal((await pdf.getMetadata()).info.Title,'Synthetic annotation corpus');
  }finally{await task.destroy();}
  assert.deepEqual(bytes,before);
  const raw=await PDFDocument.load(output),annots=raw.getPage(0).node.Annots();
  const dictionary=raw.context.lookup(annots.get(0),PDFDict);
  assert.equal(dictionary.lookup(PDFName.of('NM'),PDFHexString).decodeText(),'opendraft:rectangle');
});

test('flatten draws same appearances and removes only newly authored annotations',async()=>{
  const bytes=await base();
  const marks=[mark('rectangle'),mark('ellipse',{id:'circle',points:[[210,50],[330,140]],color:[0,0,1]}),mark('text',{points:[[50,190],[300,250]],contents:'Wrapped construction note',color:[0,0,0]}),mark('highlight',{points:[[50,280],[200,310]],color:[1,1,0],opacity:0.4}),mark('line',{points:[[20,350],[150,350]]}),mark('arrow',{points:[[210,280],[330,330]]}),mark('ink',{points:[[250,180],[290,160],[320,190]],color:[0,0.6,0]})];
  const annotated=await applyMarkups(bytes,marks),flattened=await applyMarkups(bytes,marks,{flatten:true});
  const task=load(flattened);
  try{assert.equal((await(await(await task.promise).getPage(1)).getAnnotations()).length,0);}finally{await task.destroy();}
  const a=await pixels(annotated),b=await pixels(flattened);
  let changed=0,totalDifference=0;
  for(let i=0;i<a.length;i++){if(a[i]!==b[i])changed++;totalDifference+=Math.abs(a[i]-b[i]);}
  assert.ok(a.some((value,index)=>index%4!==3&&value<100),'appearance produces non-white pixels');
  assert.ok(totalDifference/a.length<0.2,`same appearances diverged: mean channel difference ${totalDifference/a.length}, ${changed} channels changed`);
  const withExisting=await applyMarkups(bytes,[mark('line',{id:'existing'})]);
  const appended=await applyMarkups(withExisting,[mark('rectangle',{id:'new'})],{flatten:true});
  const retained=load(appended);try{const annotations=await(await(await retained.promise).getPage(1)).getAnnotations();assert.equal(annotations.length,1);assert.equal(annotations[0].subtype,'Line');}finally{await retained.destroy();}
});

test('markup export preserves source attachments and unrelated annotations on append',async()=>{
  const pdf=await PDFDocument.create();pdf.addPage([400,400]);await pdf.attach(new Uint8Array([1,2,3]),'reference.bin');
  const first=await applyMarkups(await pdf.save(),[mark('rectangle')]);
  const second=await applyMarkups(first,[mark('ellipse',{locked:true,status:'accepted'})]);
  const task=load(second);try{const result=await task.promise;assert.equal((await(await result.getPage(1)).getAnnotations()).length,2);const attachments=await result.getAttachments();assert.equal(attachments.size,1);const [[id,item]]=attachments;assert.deepEqual(item.content??await result.getAttachmentContent(id),new Uint8Array([1,2,3]));}finally{await task.destroy();}
  await assert.rejects(applyMarkups(first,[mark('rectangle')]),/already contains/);
});

test('invalid geometry, encoding, identity and properties fail rather than silently changing notes',async()=>{
  const bytes=await base();
  for(const changed of [{pageIndex:3},{id:''},{kind:'signature'},{points:[[0,0],[NaN,4]]},{points:[[-1,10],[20,20]]},{color:[1,0,2]},{width:0},{opacity:2},{contents:'Engineering \u6c34'},{status:'approved'},{createdAt:'invalid'},{points:[[10,10],[10,20]]}])await assert.rejects(applyMarkups(bytes,[mark('rectangle',changed)]));
  await assert.rejects(applyMarkups(bytes,[mark(),mark()]),/Duplicate/);
  await assert.rejects(applyMarkups(bytes,[mark('text',{points:[[10,10],[50,30]],contents:'This note cannot fit in a tiny annotation box'})]),/does not fit/);
});

test('recovery markup validation deep-clones allowed fields and enforces actual ISO dates',()=>{
  const source=mark('rectangle',{extraAction:'javascript:bad()'}),copy=validateMarkups([source],1);
  copy[0].points[0][0]=99;copy[0].color[0]=0;
  assert.equal(source.points[0][0],50);assert.equal(source.color[0],1);assert.equal('extraAction' in copy[0],false);
  for(const changed of [{createdAt:'2026-02-30T12:00:00.000Z'},{modifiedAt:'2026-10-21'},{id:42},{author:'A'.repeat(201)},{contents:'\u6c34'}])assert.throws(()=>validateMarkups([mark('rectangle',changed)],1));
  assert.throws(()=>validateMarkups([mark()],0));
});
