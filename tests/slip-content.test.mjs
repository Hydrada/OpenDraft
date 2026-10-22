import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFNumber, StandardFonts, degrees} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {assemblePdf, PageHistory} from '../apps/opendraft/src/organization.ts';
import {materializeWorkspace} from '../apps/opendraft/src/workspace-export.ts';
const name=PDFName.of;
const ref=(pageIndex,replacement,rotation=0)=>({sourceId:'base',pageIndex,rotation,...(replacement?{replacement}: {})});
async function fixture(text='BASE', donor=false){
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);
 pdf.setTitle(donor?'Donor title':'Original title');
 for(let i=0;i<2;i++){
  const page=pdf.addPage(donor?[300,400]:[500,600]);page.drawText(`${text} ${i}`,{x:30,y:100,font,size:16});
  page.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],Contents:PDFString.of(donor?'DONOR COMMENT':'TARGET COMMENT'),P:page.ref})));
  if(donor){page.setCropBox(10,15,260,350);page.setRotation(degrees(90));page.node.set(name('UserUnit'),PDFNumber.of(2));}
  else {page.setBleedBox(1,2,450,550);page.setTrimBox(3,4,440,540);page.setArtBox(5,6,430,530);}
 }
 if(!donor){
  const pages=pdf.getPages();const outlines=pdf.context.obj({Type:'Outlines',Count:1}),outlineRef=pdf.context.register(outlines);
  const item=pdf.context.register(pdf.context.obj({Title:PDFString.of('Original bookmark'),Parent:outlineRef,Dest:[pages[0].ref,name('Fit')]}));
  outlines.set(name('First'),item);outlines.set(name('Last'),item);pdf.catalog.set(name('Outlines'),outlineRef);
  pdf.catalog.set(name('PageLabels'),pdf.context.obj({Nums:[0,{P:PDFString.of('A-'),S:'D',St:101}]}));
  await pdf.attach(new TextEncoder().encode('base attachment'),'base.txt');
  const field=pdf.getForm().createTextField('base-field');field.setText('original field');field.addToPage(pages[0],{x:50,y:200,width:140,height:30});pdf.getForm().updateFieldAppearances(font);
 }
 return pdf.save({updateFieldAppearances:false});
}
async function reader(bytes,inspect){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{return await inspect(await task.promise);}finally{await task.destroy();}}
async function texts(bytes){return reader(bytes,async pdf=>{const texts=[];for(let n=1;n<=pdf.numPages;n++)texts.push((await(await pdf.getPage(n)).getTextContent()).items.map(item=>item.str??'').join(' '));return texts;});}

test('full slip preserves target page references/catalog/annotations, replaces content and geometry, excludes donor comments',async()=>{
 const base=await fixture(),donor=await fixture('REVISION',true),originals=[base.slice(),donor.slice()],sources=new Map([['donor',donor],['base',base]]);
 const before=await PDFDocument.load(base,{updateMetadata:false});
 const bytes=await assemblePdf(sources,[ref(0,{sourceId:'donor',pageIndex:1},90),ref(1)]);
 const pdf=await PDFDocument.load(bytes,{updateMetadata:false}),page=pdf.getPage(0);
 assert.deepEqual(await texts(bytes),['REVISION 1','BASE 1']);
 assert.equal(page.ref.toString(),before.getPage(0).ref.toString());assert.equal(pdf.getPage(1).ref.toString(),before.getPage(1).ref.toString());
 assert.deepEqual(page.getMediaBox(),{x:0,y:0,width:300,height:400});assert.deepEqual(page.getCropBox(),{x:10,y:15,width:260,height:350});assert.equal(page.getRotation().angle,180);assert.equal(page.node.lookup(name('UserUnit'),PDFNumber).asNumber(),2);
 for(const key of ['BleedBox','TrimBox','ArtBox'])assert.equal(page.node.has(name(key)),false);
 const comments=page.node.lookup(name('Annots'),PDFArray).asArray().map(value=>pdf.context.lookup(value,PDFDict));assert.ok(comments.some(a=>a.get(name('Contents'))?.decodeText()==='TARGET COMMENT'));assert.ok(!comments.some(a=>a.get(name('Contents'))?.decodeText()==='DONOR COMMENT'));
 assert.equal(pdf.getTitle(),'Original title');assert.equal(pdf.getForm().getTextField('base-field').getText(),'original field');assert.equal(pdf.catalog.get(name('Outlines')).toString(),before.catalog.get(name('Outlines')).toString());
 await reader(bytes,async r=>{assert.deepEqual(await r.getPageLabels(),['A-101','A-102']);assert.equal((await r.getOutline())[0].title,'Original bookmark');assert.ok((await r.getAttachments()).has('base.txt'));const p=await r.getPage(1);assert.equal(p.rotate,180);assert.equal(p.userUnit,2);assert.deepEqual(p.view,[10,15,270,365]);});
 assert.deepEqual([base,donor],originals);
});

test('materialization rebuilds from original replacement sources without compounding edits',async()=>{
 const base=await fixture(),donor=await fixture('REVISION',true),sources=new Map([['base',base],['donor',donor]]),pages=[ref(0,{sourceId:'donor',pageIndex:0},90),ref(1)];
 const first=await materializeWorkspace(sources,pages,[]);const second=await materializeWorkspace(sources,[{...pages[0],rotation:180},pages[1]],[]);
 assert.equal((await PDFDocument.load(first)).getPage(0).getRotation().angle,180);assert.equal((await PDFDocument.load(second)).getPage(0).getRotation().angle,270);assert.deepEqual(await texts(second),['REVISION 0','BASE 1']);
});

test('same-document replacement swaps use original content and keep distinct target comments',async()=>{
 const base=await fixture(),bytes=await assemblePdf(new Map([['base',base]]),[ref(0,{sourceId:'base',pageIndex:1}),ref(1,{sourceId:'base',pageIndex:0})]);
 assert.deepEqual(await texts(bytes),['BASE 1','BASE 0']);
});

test('replacement metadata is validated and isolated from caller/history mutation',async()=>{
 const base=await fixture(),sources=new Map([['base',base]]);
 for(const replacement of [null,{sourceId:'',pageIndex:0},{sourceId:'base',pageIndex:-1},{sourceId:'base',pageIndex:0.5},{sourceId:'missing',pageIndex:0},{sourceId:'base',pageIndex:2}]){
  const page={sourceId:'base',pageIndex:0,rotation:0,replacement};await assert.rejects(assemblePdf(sources,[page,ref(1)]));await assert.rejects(materializeWorkspace(sources,[page,ref(1)],[]));
 }
 const pages=[ref(0,{sourceId:'base',pageIndex:1}),ref(1)],history=new PageHistory(pages);pages[0].replacement.pageIndex=0;const snapshot=history.pages;snapshot[0].replacement.pageIndex=0;assert.equal(history.pages[0].replacement.pageIndex,1);
});

test('signed, XFA, encrypted and optional-content donor PDFs are rejected before rewriting',async()=>{
 const base=await fixture();
 for(const change of [pdf=>pdf.context.register(pdf.context.obj({Type:'Sig',ByteRange:[0,10,20,30]})),pdf=>pdf.catalog.set(name('AcroForm'),pdf.context.obj({Fields:[],XFA:PDFString.of('XFA')})),pdf=>pdf.context.trailerInfo.Encrypt=pdf.context.register(pdf.context.obj({Filter:'Standard'})),pdf=>pdf.catalog.set(name('OCProperties'),pdf.context.obj({OCGs:[]}))]){
  const pdf=await PDFDocument.create();pdf.addPage();change(pdf);const donor=await pdf.save({useObjectStreams:false}),before=donor.slice(),sources=new Map([['base',base],['donor',donor]]);
  await assert.rejects(assemblePdf(sources,[ref(0,{sourceId:'donor',pageIndex:0}),ref(1)]),/blocked|layers|encrypted|XFA|signature/i);await assert.rejects(materializeWorkspace(sources,[ref(0,{sourceId:'donor',pageIndex:0}),ref(1)],[]));assert.deepEqual(donor,before);
 }
});

test('copied resource page backreferences resolve to target, without importing donor annotations',async()=>{
 const base=await fixture(),donorPdf=await PDFDocument.load(await fixture('REVISION',true)),donorPage=donorPdf.getPage(0);
 const resource=donorPdf.context.register(donorPdf.context.obj({P:donorPage.ref,Marker:PDFString.of('page-owned-resource')}));donorPage.node.Resources().set(name('PieceInfo'),resource);const donor=await donorPdf.save({updateFieldAppearances:false});
 const bytes=await assemblePdf(new Map([['base',base],['donor',donor]]),[ref(0,{sourceId:'donor',pageIndex:0}),ref(1)]),pdf=await PDFDocument.load(bytes),page=pdf.getPage(0);
 assert.equal(page.node.Resources().lookup(name('PieceInfo'),PDFDict).get(name('P')).toString(),page.ref.toString());
 for(const [,obj]of pdf.context.enumerateIndirectObjects())if(obj instanceof PDFDict)assert.notEqual(obj.get(name('Contents'))?.decodeText?.(),'DONOR COMMENT');
});

test('partial output keeps copied target annotations while adopting donor content and base Info',async()=>{
 const base=await fixture(),donor=await fixture('REVISION',true),bytes=await assemblePdf(new Map([['donor',donor],['base',base]]),[ref(0,{sourceId:'donor',pageIndex:0})]),pdf=await PDFDocument.load(bytes);
 assert.equal(pdf.getTitle(),'Original title');assert.deepEqual(await texts(bytes),['REVISION 0']);assert.ok(pdf.getPage(0).node.lookup(name('Annots'),PDFArray).asArray().some(value=>pdf.context.lookup(value,PDFDict).get(name('Contents'))?.decodeText()==='TARGET COMMENT'));
});


test('donor defaults override old inherited target rotation/crop/resources and transparency group',async()=>{
 const basePdf=await PDFDocument.load(await fixture());const root=basePdf.catalog.Pages();root.set(name('Rotate'),PDFNumber.of(90));root.set(name('CropBox'),basePdf.context.obj([20,30,400,500]));basePdf.getPage(0).node.delete(name('Rotate'));basePdf.getPage(0).node.delete(name('CropBox'));basePdf.getPage(0).node.set(name('UserUnit'),PDFNumber.of(3));basePdf.getPage(0).node.set(name('Group'),basePdf.context.obj({Type:'Group',S:'Transparency',CS:'DeviceRGB'}));
 const donorPdf=await PDFDocument.create({updateMetadata:false});donorPdf.addPage([200,300]);const donor=await donorPdf.save();
 const bytes=await assemblePdf(new Map([['base',await basePdf.save({updateFieldAppearances:false})],['donor',donor]]),[ref(0,{sourceId:'donor',pageIndex:0}),ref(1)]),pdf=await PDFDocument.load(bytes),page=pdf.getPage(0);
 assert.equal(page.getRotation().angle,0);assert.deepEqual(page.getCropBox(),{x:0,y:0,width:200,height:300});assert.equal(page.node.has(name('UserUnit')),false);assert.equal(page.node.has(name('Group')),false);assert.equal(page.node.Resources().has(name('Font')),false);
 await reader(bytes,async r=>{const p=await r.getPage(1);assert.equal(p.rotate,0);assert.equal(p.userUnit,1);assert.deepEqual(p.view,[0,0,200,300]);});
});

test('transparency groups copy with drawing contents; foreign page resource dependencies reject',async()=>{
 const base=await fixture(),donorPdf=await PDFDocument.load(await fixture('REVISION',true));donorPdf.getPage(0).node.set(name('Group'),donorPdf.context.obj({Type:'Group',S:'Transparency',CS:'DeviceGray'}));
 const sources=new Map([['base',base],['donor',await donorPdf.save({updateFieldAppearances:false})]]),pages=[ref(0,{sourceId:'donor',pageIndex:0}),ref(1)];
 const pdf=await PDFDocument.load(await assemblePdf(sources,pages));assert.equal(pdf.getPage(0).node.lookup(name('Group'),PDFDict).get(name('CS')).toString(),'/DeviceGray');
 donorPdf.getPage(0).node.Resources().set(name('ForeignPage'),donorPdf.getPage(1).ref);sources.set('donor',await donorPdf.save({updateFieldAppearances:false}));await assert.rejects(assemblePdf(sources,pages),/another page|cross-page/);
});
