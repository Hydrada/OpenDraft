import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFString,PDFHexString,StandardFonts} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {assemblePdf} from '../apps/opendraft/src/organization.ts';
const name=PDFName.of, ref=(sourceId,pageIndex,rotation=0)=>({sourceId,pageIndex,rotation});
const xml='<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original XMP title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';

async function fixture(title='Primary 源 title'){
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let i=0;i<3;i++)pdf.addPage([400,500]).drawText(`Sheet ${i+1}`,{x:30,y:450,size:12,font});
 pdf.setTitle(title);pdf.setAuthor('Original author');pdf.setCreator('Original creator');pdf.setProducer('Original producer');pdf.setCreationDate(new Date('2020-01-02T03:04:05.000Z'));pdf.setModificationDate(new Date('2021-02-03T04:05:06.000Z'));
 pdf.context.lookup(pdf.context.trailerInfo.Info,PDFDict).set(name('ProjectCode'),PDFHexString.fromText('工程-42'));
 pdf.catalog.set(name('Metadata'),pdf.context.register(pdf.context.stream(new TextEncoder().encode(xml),{Type:'Metadata',Subtype:'XML'})));
 await pdf.attach(new TextEncoder().encode('Authorized source attachment'),'note.txt');
 const pages=pdf.getPages(),outlines=pdf.context.obj({Type:'Outlines',Count:2}),outlineRef=pdf.context.register(outlines);
 const explicit=pdf.context.obj({Title:PDFHexString.fromText('Detail sheet'),Parent:outlineRef,Dest:[pages[2].ref,name('Fit')]}),explicitRef=pdf.context.register(explicit);
 const named=pdf.context.obj({Title:PDFHexString.fromText('Named detail'),Parent:outlineRef,Dest:PDFString.of('detail'),Prev:explicitRef}),namedRef=pdf.context.register(named);
 explicit.set(name('Next'),namedRef);outlines.set(name('First'),explicitRef);outlines.set(name('Last'),namedRef);pdf.catalog.set(name('Outlines'),outlineRef);
 pdf.catalog.set(name('Names'),pdf.context.obj({Dests:{Names:[PDFString.of('detail'),[pages[2].ref,name('Fit')],PDFString.of('numeric'),{D:[1,name('Fit')]}]}}));
 pdf.catalog.set(name('Dests'),pdf.context.obj({Legacy:[0,name('Fit')]}));
 pdf.catalog.set(name('OpenAction'),pdf.context.obj([1,name('Fit')]));
 pdf.catalog.set(name('PageLabels'),pdf.context.obj({Nums:[0,{S:'D',P:PDFString.of('Sheet-'),St:10}]}));
 const ocg=pdf.context.register(pdf.context.obj({Type:'OCG',Name:PDFHexString.fromText('Source dimensions')}));pdf.catalog.set(name('OCProperties'),pdf.context.obj({OCGs:[ocg],D:{Order:[ocg],ON:[ocg]}}));
 for(const entry of [
  {Dest:[pages[2].ref,name('Fit')]},
  {Dest:[2,name('Fit')]},
  {A:{S:'GoTo',D:[1,name('Fit')]}},
  {A:{S:'GoToR',F:PDFString.of('other.pdf'),D:[1,name('Fit')]}},
 ])pages[0].node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[20,20,120,40],...entry})));
 const field=pdf.getForm().createTextField('asset');field.setText('Valve V-2');field.addToPage(pages[1],{x:30,y:100,width:150,height:24});pdf.getForm().updateFieldAppearances(font);
 return pdf.save({updateFieldAppearances:false});
}
async function doc(bytes){return PDFDocument.load(bytes,{updateMetadata:false});}
function info(pdf){const value=pdf.context.trailerInfo.Info?pdf.context.lookup(pdf.context.trailerInfo.Info,PDFDict):undefined;return value?value.entries().map(([k,v])=>[k.toString(),v.toString()]).sort():null;}
function metadata(pdf){return pdf.catalog.lookup(name('Metadata')).getContents();}
async function independent(bytes,inspect){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{return await inspect(await task.promise);}finally{await task.destroy();}}

test('full permutations retain page references and live catalog structures while remapping labels and local numeric destinations',async()=>{
 const bytes=await fixture(),before=bytes.slice(),source=await doc(bytes),output=await assemblePdf(new Map([['A',bytes]]),[ref('A',2),ref('A',0,90),ref('A',1)]),pdf=await doc(output);
 assert.deepEqual(pdf.getPages().map(page=>page.ref.toString()),[2,0,1].map(i=>source.getPage(i).ref.toString()));
 assert.deepEqual(info(pdf),info(source));assert.deepEqual(metadata(pdf),metadata(source));assert.deepEqual(bytes,before);
 assert.equal(pdf.getForm().getTextField('asset').getText(),'Valve V-2');
 assert.equal(pdf.catalog.get(name('Outlines')).toString(),source.catalog.get(name('Outlines')).toString());
 const links=pdf.getPage(1).node.lookup(name('Annots'),PDFArray).asArray().map(r=>pdf.context.lookup(r,PDFDict));
 assert.equal(links[0].lookup(name('Dest'),PDFArray).get(0).toString(),pdf.getPage(0).ref.toString());
 assert.equal(links[1].lookup(name('Dest'),PDFArray).lookup(0).asNumber(),0);
 assert.equal(links[2].lookup(name('A'),PDFDict).lookup(name('D'),PDFArray).lookup(0).asNumber(),2);
 assert.equal(links[3].lookup(name('A'),PDFDict).lookup(name('D'),PDFArray).lookup(0).asNumber(),1);
 assert.equal(pdf.catalog.lookup(name('OpenAction'),PDFArray).lookup(0).asNumber(),2);
 assert.equal(pdf.catalog.lookup(name('Dests'),PDFDict).lookup(name('Legacy'),PDFArray).lookup(0).asNumber(),1);
 await independent(output,async reader=>{
  assert.deepEqual(await reader.getPageLabels(),['Sheet-12','Sheet-10','Sheet-11']);
  const outline=await reader.getOutline();assert.equal(outline.length,2);assert.equal(await reader.getPageIndex(outline[0].dest[0]),0);
  assert.equal(await reader.getPageIndex((await reader.getDestination('detail'))[0]),0);
  assert.equal((await reader.getDestination('numeric'))[0],2);
  const attachments=await reader.getAttachments();assert.equal(new TextDecoder().decode(attachments.get('note.txt').content ?? await reader.getAttachmentContent('note.txt')),'Authorized source attachment');
  const layers=await reader.getOptionalContentConfig();assert.ok([...layers].some(([,layer])=>layer.name==='Source dimensions'));
  const field=(await (await reader.getPage(3)).getAnnotations({intent:'any'})).find(a=>a.fieldName==='asset');assert.equal(field.fieldValue,'Valve V-2');
  const parsed=await reader.getMetadata();assert.equal(parsed.info.Title,'Primary 源 title');assert.ok(parsed.metadata.getRaw().includes('Original XMP title'));
 });
});

test('full permutation materializes nested inherited page resources, boxes and rotation before reparenting',async()=>{
 const pdf=await PDFDocument.create({updateMetadata:false});pdf.addPage([400,500]);pdf.addPage([400,500]);
 const pages=pdf.getPages(),root=pdf.catalog.Pages(),rootRef=pdf.catalog.get(name('Pages'));
 root.set(name('MediaBox'),pdf.context.obj([0,0,400,500]));root.set(name('CropBox'),pdf.context.obj([10,15,390,480]));root.set(name('Rotate'),pdf.context.obj(90));
 const resources=pdf.context.register(pdf.context.obj({ProcSet:['PDF']}));
 const child=pdf.context.register(pdf.context.obj({Type:'Pages',Parent:rootRef,Kids:pages.map(p=>p.ref),Count:2,Resources:resources}));
 root.set(name('Kids'),pdf.context.obj([child]));
 for(const page of pages){page.node.set(name('Parent'),child);for(const key of ['MediaBox','CropBox','Resources','Rotate'])page.node.delete(name(key));}
 const bytes=await pdf.save({updateFieldAppearances:false}),result=await assemblePdf(new Map([['A',bytes]]),[ref('A',1),ref('A',0,90)]),parsed=await doc(result);
 assert.deepEqual(parsed.getPages().map(p=>p.node.get(name('Resources')).toString()),[resources.toString(),resources.toString()]);
 await independent(result,async reader=>{for(let i=1;i<=2;i++){const page=await reader.getPage(i);assert.deepEqual(page.view,[10,15,390,480]);assert.equal(page.rotate,i===1?90:180);}});
});

test('extraction, deletion, duplication and merge retain stable primary Info/XMP without inventing metadata',async()=>{
 const a=await fixture(),b=await fixture('Secondary title'),originals=[a.slice(),b.slice()],sources=new Map([['A',a],['B',b]]),expected=await doc(a);
 for(const pages of [[ref('A',1)],[ref('A',0),ref('A',2)],[ref('A',2),ref('A',2)],[ref('B',0),ref('A',2)],[ref('A',2),ref('B',0)]]){
  const pdf=await doc(await assemblePdf(sources,pages));assert.deepEqual(info(pdf),info(expected));assert.deepEqual(metadata(pdf),metadata(expected));assert.equal(pdf.getPageCount(),pages.length);
  assert.equal(pdf.catalog.has(name('Outlines')),false);assert.equal(pdf.catalog.has(name('OCProperties')),false);
 }
 const onlyB=await doc(await assemblePdf(sources,[ref('B',0)]));assert.equal(onlyB.getTitle(),'Secondary title');
 const blank=await PDFDocument.create({updateMetadata:false});blank.addPage();blank.addPage();const absent=await blank.save();
 const noMetadata=await doc(await assemblePdf(new Map([['blank',absent]]),[ref('blank',0)]));assert.equal(info(noMetadata),null);assert.equal(noMetadata.catalog.has(name('Metadata')),false);
 assert.deepEqual([a,b],originals);
});

test('direct page organization rejects apparent signatures, certification and XFA on every used source',async()=>{
 for(const configure of [
  pdf=>pdf.catalog.set(name('Perms'),pdf.context.obj({DocMDP:pdf.context.register(pdf.context.obj({Type:'Sig'}))})),
  pdf=>pdf.context.register(pdf.context.obj({Type:'Sig',ByteRange:[0,10,20,30]})),
  pdf=>pdf.catalog.set(name('AcroForm'),pdf.context.obj({Fields:[],XFA:PDFString.of('unsupported synthetic XFA')})),
 ]){
  const pdf=await PDFDocument.create({updateMetadata:false});pdf.addPage();pdf.addPage();configure(pdf);const bytes=await pdf.save(),before=bytes.slice();
  for(const pages of [[ref('A',1),ref('A',0)],[ref('A',0)]])await assert.rejects(assemblePdf(new Map([['A',bytes]]),pages),/blocked|signature|XFA/i);
  assert.deepEqual(bytes,before);
 }
});

test('malformed page-label trees and numeric local destinations reject before producing a misleading permutation',async()=>{
 for(const configure of [
  pdf=>pdf.catalog.set(name('PageLabels'),pdf.context.obj({Nums:[1,{S:'D'}]})),
  pdf=>pdf.catalog.set(name('PageLabels'),pdf.context.obj({Nums:[0,{S:'D',St:0}]})),
  pdf=>pdf.catalog.set(name('OpenAction'),pdf.context.obj([10,name('Fit')])),
 ]){const pdf=await PDFDocument.create({updateMetadata:false});pdf.addPage();pdf.addPage();configure(pdf);const bytes=await pdf.save();await assert.rejects(assemblePdf(new Map([['A',bytes]]),[ref('A',1),ref('A',0)]),/page.label|destination/i);}
});

