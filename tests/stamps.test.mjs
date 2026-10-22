import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PDFDocument, PDFName, PDFDict, PDFNumber, decodePDFRawStream, StandardFonts} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import {applyMarkups, validateMarkups, STAMP_NAMES} from '../apps/opendraft/src/annotations.ts';
const time='2026-10-21T12:00:00.000Z';
const mark=(extra={})=>({id:'review-stamp',pageIndex:0,kind:'stamp',stampName:'Draft',points:[[40,100],[240,180]],color:[0.7,0.1,0.1],width:2,opacity:0.6,contents:'',author:'Reviewer A',status:'open',locked:true,createdAt:time,modifiedAt:time,...extra});
async function base(){const pdf=await PDFDocument.create();pdf.addPage([400,400]);pdf.setTitle('Source drawing');return pdf.save();}
function appearance(pdf,annotation){const stream=annotation.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N'));return {stream,commands:new TextDecoder().decode(decodePDFRawStream(stream).decode())};}
async function pixels(bytes){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{const page=await(await task.promise).getPage(1),viewport=page.getViewport({scale:1}),canvas=createCanvas(400,400);await page.render({canvas,viewport}).promise;return canvas.getContext('2d').getImageData(0,0,400,400).data;}finally{await task.destroy();}}

test('all standard stamp names export explicit bold appearances, default labels and reviewer metadata',async()=>{
  assert.equal(STAMP_NAMES.length,14);
  const source=await base(),snapshot=source.slice(),marks=STAMP_NAMES.map((stampName,i)=>mark({id:`stamp-${i}`,stampName}));
  const saved=await applyMarkups(source,marks),pdf=await PDFDocument.load(saved);
  const annots=pdf.getPage(0).node.Annots();assert.equal(annots.size(),14);
  const font=await pdf.embedFont(StandardFonts.HelveticaBold);
  for(let i=0;i<STAMP_NAMES.length;i++){
    const annotation=pdf.context.lookup(annots.get(i),PDFDict),{stream,commands}=appearance(pdf,annotation);
    assert.equal(annotation.lookup(PDFName.of('Subtype')).toString(),'/Stamp');
    assert.equal(annotation.lookup(PDFName.of('Name')).toString(),`/${STAMP_NAMES[i]}`);
    assert.equal(annotation.lookup(PDFName.of('T')).decodeText(),'Reviewer A');
    assert.equal(annotation.lookup(PDFName.of('F'),PDFNumber).asNumber(),644);
    const fonts=stream.dict.lookup(PDFName.of('Resources'),PDFDict).lookup(PDFName.of('Font'),PDFDict);
    assert.equal(fonts.lookup(PDFName.of('F0'),PDFDict).lookup(PDFName.of('BaseFont')).toString(),'/Helvetica-Bold');
    assert.match(commands,/2 2 200 80 re S/);
    // Blank label uses the independently authored standard-name fallback, not proprietary stamp art.
    const expected=STAMP_NAMES[i].replace(/([a-z])([A-Z])/g,'$1 $2').toUpperCase();
    const textHex=[...commands.matchAll(/<([0-9A-F]+)> Tj/g)].map(m=>m[1]).join('');
    assert.equal(textHex,font.encodeText(expected).toString().slice(1,-1));
    const size=Number(commands.match(/\/F0 ([\d.]+) Tf/)[1]);assert.ok(size>=8&&size<=36);
    const gs=stream.dict.lookup(PDFName.of('Resources'),PDFDict).lookup(PDFName.of('ExtGState'),PDFDict).lookup(PDFName.of('GS0'),PDFDict);
    assert.equal(gs.lookup(PDFName.of('ca'),PDFNumber).asNumber(),0.6);
  }
  assert.equal(pdf.getTitle(),'Source drawing');assert.deepEqual(source,snapshot);
  const task=getDocument({data:saved.slice()});try{const annotations=await(await(await task.promise).getPage(1)).getAnnotations();assert.equal(annotations.length,14);assert.ok(annotations.every(a=>a.hasAppearance));}finally{await task.destroy();}
});

test('stamp schema rejects invalid names, misplaced fields, degenerate geometry and unsupported labels',async()=>{
  for(const stampName of [undefined,'Unknown','/Approved','Approved\n','__proto__',0,null])assert.throws(()=>validateMarkups([mark({stampName})],1));
  assert.throws(()=>validateMarkups([mark({kind:'rectangle'})],1),/only for stamp/);
  assert.throws(()=>validateMarkups([mark({points:[[40,100],[40,180]]})],1),/positive/);
  assert.throws(()=>validateMarkups([mark({contents:'Approval 🛠'})],1));
  const input=mark(),canonical=validateMarkups([input],1)[0];canonical.points[0][0]=999;canonical.color[0]=0;
  assert.equal(canonical.stampName,'Draft');assert.equal(input.points[0][0],40);assert.equal(input.color[0],0.7);
  const source=await base();
  await assert.rejects(applyMarkups(source,[mark({points:[[40,100],[50,110]]})]),/minimum 8 point/);
  await assert.rejects(applyMarkups(source,[mark({contents:'Review '.repeat(1000),points:[[40,100],[80,130]]})]),/minimum 8 point/);
  await assert.rejects(applyMarkups(source,[mark({points:[[-1,100],[200,180]]})]),/outside/);
});

test('custom multiline labels fit or fail explicitly and authored flattening preserves foreign annotations',async()=>{
  const source=await base(),custom=mark({contents:'REVIEWED\nCHECK CLEARANCE',points:[[240,180],[40,100]]}),snapshot=structuredClone(custom);
  const saved=await applyMarkups(source,[custom]),flat=await applyMarkups(source,[custom],{flatten:true});
  const pdf=await PDFDocument.load(saved),annotation=pdf.context.lookup(pdf.getPage(0).node.Annots().get(0),PDFDict),{commands}=appearance(pdf,annotation);
  assert.ok((commands.match(/ Tj/g)??[]).length >= 2);
  const font=await pdf.embedFont(StandardFonts.HelveticaBold);
  assert.equal([...commands.matchAll(/<([0-9A-F]+)> Tj/g)].map(m=>m[1]).join(''),font.encodeText(custom.contents.replaceAll('\n','')).toString().slice(1,-1));
  const size=Number(commands.match(/\/F0 ([\d.]+) Tf/)[1]);assert.ok(size>=8&&size<36);
  const a=await pixels(saved),b=await pixels(flat);let total=0,nonwhite=0;for(let i=0;i<a.length;i++){total+=Math.abs(a[i]-b[i]);if(i%4!==3&&a[i]<240)nonwhite++;}
  assert.ok(total/a.length<0.2,`mean channel difference ${total/a.length}`);assert.ok(nonwhite>50);
  const flattened=await PDFDocument.load(flat);assert.equal(flattened.getPage(0).node.Annots()?.size()??0,0);assert.equal(flattened.getTitle(),'Source drawing');
  const existing=await applyMarkups(source,[mark({id:'existing',kind:'rectangle',stampName:undefined,contents:'Existing'})]);
  const appended=await PDFDocument.load(await applyMarkups(existing,[custom],{flatten:true}));assert.equal(appended.getPage(0).node.Annots().size(),1);
  assert.deepEqual(custom,snapshot);
});
