import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFString,PDFNumber,StandardFonts,degrees} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {assemblePdf,validatePages,PageHistory} from '../apps/opendraft/src/organization.ts';
import {materializeWorkspace} from '../apps/opendraft/src/workspace-export.ts';
const n=PDFName.of, base=(pageIndex,extra={})=>({sourceId:'base',pageIndex,rotation:0,...extra});
const insert=(extra={})=>({sourceId:'donor',pageIndex:0,rotation:0,inserted:true,...extra});
async function fixture(donor=false,labels=true){
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.setTitle(donor?'Donor title':'Base title');
 for(let i=0;i<2;i++){
  const page=pdf.addPage(donor?[240,180]:[300,400]);page.drawText(`${donor?'REVISION':'ORIGINAL'} ${i}`,{x:20,y:80,font,size:12});
  if(donor){page.setCropBox(10,5,220,160);page.setRotation(degrees(90));page.node.set(n('UserUnit'),PDFNumber.of(2));page.node.set(n('AA'),pdf.context.obj({O:{S:'JavaScript',JS:PDFString.of('never execute')}}));}
  page.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[10,10,30,30],P:page.ref,Contents:PDFString.of(donor?'DONOR ANNOT':'BASE ANNOT')})));
 }
 const pages=pdf.getPages();
 const field=pdf.getForm().createTextField(donor?'donor-field':'base-field');field.setText(donor?'donor form':'base form');field.addToPage(pages[0],{x:50,y:110,width:100,height:20});pdf.getForm().updateFieldAppearances(font);
 if(!donor){
  await pdf.attach(new TextEncoder().encode('keep attachment'),'base.txt');
  const outlines=pdf.context.obj({Type:'Outlines',Count:1}),outlineRef=pdf.context.register(outlines),item=pdf.context.register(pdf.context.obj({Title:PDFString.of('Original first'),Parent:outlineRef,Dest:[pages[0].ref,n('Fit')]}));outlines.set(n('First'),item);outlines.set(n('Last'),item);pdf.catalog.set(n('Outlines'),outlineRef);
  const names=pdf.catalog.lookupMaybe(n('Names'),PDFDict)??pdf.context.obj({});pdf.catalog.set(n('Names'),names);names.set(n('Dests'),pdf.context.obj({Names:[PDFString.of('first'),[pages[0].ref,n('Fit')],PDFString.of('numeric'),{D:[0,n('Fit')]}]}));
  pdf.catalog.set(n('OpenAction'),pdf.context.obj([0,n('Fit')]));
  pages[1].node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[30,30,80,50],A:{S:'GoTo',D:[0,n('Fit')]}})));
  if(labels)pdf.catalog.set(n('PageLabels'),pdf.context.obj({Nums:[0,{S:'D',P:PDFString.of('A'),St:101}]}));
 }
 return pdf.save({updateFieldAppearances:false});
}
async function reader(bytes,inspect){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{return await inspect(await task.promise);}finally{await task.destroy();}}
async function texts(bytes){return reader(bytes,async pdf=>{const output=[];for(let i=1;i<=pdf.numPages;i++)output.push((await(await pdf.getPage(i)).getTextContent()).items.map(x=>x.str??'').join(' '));return output;});}
function contentText(pdf,page){return page.node.lookupMaybe(n('Annots'),PDFArray)?.asArray().map(ref=>pdf.context.lookup(ref,PDFDict).get(n('Contents'))?.decodeText());}

test('inserted drawing pages retain original navigation, catalog, labels, annotations and source bytes',async()=>{
 const a=await fixture(),b=await fixture(true),before=[a.slice(),b.slice()],source=await PDFDocument.load(a),sources=new Map([['donor',b],['base',a]]);
 const result=await assemblePdf(sources,[insert({label:'A101-R1 工程'}),base(0),insert({label:'A101-R2'}),base(1)]),pdf=await PDFDocument.load(result);
 assert.deepEqual(await texts(result),['REVISION 0','ORIGINAL 0','REVISION 0','ORIGINAL 1']);
 assert.equal(pdf.getPageCount(),4);assert.equal(pdf.getTitle(),'Base title');assert.equal(pdf.getPage(1).ref.toString(),source.getPage(0).ref.toString());assert.equal(pdf.getPage(3).ref.toString(),source.getPage(1).ref.toString());assert.notEqual(pdf.getPage(0).ref.toString(),pdf.getPage(2).ref.toString());
 assert.equal(pdf.getForm().getTextField('base-field').getText(),'base form');assert.throws(()=>pdf.getForm().getTextField('donor-field'));
 for(const i of [0,2]){const page=pdf.getPage(i);assert.equal(page.node.has(n('Annots')),false);assert.equal(page.node.has(n('AA')),false);assert.equal(page.getRotation().angle,90);assert.equal(page.node.lookup(n('UserUnit'),PDFNumber).asNumber(),2);assert.deepEqual(page.getCropBox(),{x:10,y:5,width:220,height:160});}
 assert.ok(contentText(pdf,pdf.getPage(1)).includes('BASE ANNOT'));assert.equal(pdf.catalog.lookup(n('OpenAction'),PDFArray).lookup(0).asNumber(),1);
 const link=pdf.getPage(3).node.lookup(n('Annots'),PDFArray).asArray().map(x=>pdf.context.lookup(x,PDFDict)).find(x=>x.get(n('Subtype')).toString()==='/Link');assert.equal(link.lookup(n('A'),PDFDict).lookup(n('D'),PDFArray).lookup(0).asNumber(),1);
 await reader(result,async r=>{assert.deepEqual(await r.getPageLabels(),['A101-R1 工程','A101','A101-R2','A102']);assert.equal(await r.getPageIndex((await r.getOutline())[0].dest[0]),1);assert.equal(await r.getPageIndex((await r.getDestination('first'))[0]),1);assert.equal((await r.getDestination('numeric'))[0],1);assert.ok((await r.getAttachments()).has('base.txt'));});
 assert.deepEqual([a,b],before);
});

test('default inserted labels preserve natural original page numbers when original labels are absent',async()=>{
 const sources=new Map([['base',await fixture(false,false)],['donor',await fixture(true)]]),result=await assemblePdf(sources,[insert({pageIndex:1}),base(0),base(1)]);
 await reader(result,async r=>assert.deepEqual(await r.getPageLabels(),['Revision page 2','1','2']));
});

test('repeated insertions and drawing replacements rebuild from originals without duplication or rotation compounding',async()=>{
 const sources=new Map([['base',await fixture()],['donor',await fixture(true)]]),pages=[insert({label:'R2'}),insert({label:'R1'}),base(0,{rotation:90,replacement:{sourceId:'donor',pageIndex:1}}),base(1)];
 const a=await materializeWorkspace(sources,pages,[]),b=await materializeWorkspace(sources,pages,[]);assert.deepEqual(await texts(a),['REVISION 0','REVISION 0','REVISION 1','ORIGINAL 1']);assert.deepEqual(await texts(b),await texts(a));assert.equal((await PDFDocument.load(b)).getPage(2).getRotation().angle,180);
 await reader(b,async r=>{assert.deepEqual(await r.getPageLabels(),['R2','R1','A101','A102']);assert.equal((await r.getDestination('numeric'))[0],2);});
});

test('inserted flags and labels are strictly validated and retained in isolated history snapshots',()=>{
 for(const flag of [false,0,1,'true',null])assert.throws(()=>validatePages([insert({inserted:flag})]),/flag/);
 for(const label of ['', '  ', 'x'.repeat(1001),42,null])assert.throws(()=>validatePages([insert({label})]),/label/);
 assert.throws(()=>validatePages([base(0,{label:'not inserted'})]),/label/);
 const pages=[insert({label:'R1'})],history=new PageHistory(pages);pages[0].label='changed';const snapshot=history.pages;snapshot[0].label='also changed';assert.equal(history.pages[0].label,'R1');
});

test('fallback partial extraction and donor-only insertion exclude donor annotations and actions',async()=>{
 const sources=new Map([['base',await fixture()],['donor',await fixture(true)]]);
 for(const pages of [[insert(),base(1)],[insert()]]){const output=await assemblePdf(sources,pages),pdf=await PDFDocument.load(output);assert.equal(pdf.getPage(0).node.has(n('Annots')),false);assert.equal(pdf.getPage(0).node.has(n('AA')),false);assert.ok((await texts(output))[0].includes('REVISION 0'));}
 // This has original source page count and indices, but inserted refs must never return original bytes.
 const output=await materializeWorkspace(new Map([['donor',sources.get('donor')]]),[insert(),insert({pageIndex:1})],[]),pdf=await PDFDocument.load(output);assert.equal(pdf.getPage(0).node.has(n('Annots')),false);assert.equal(pdf.catalog.has(n('AcroForm')),false);
});

test('inserted resource page backreferences point to each distinct new page; unsafe layers/cross-page resources reject',async()=>{
 const a=await fixture(),donor=await PDFDocument.load(await fixture(true)),page=donor.getPage(0);page.node.Resources().set(n('PieceInfo'),donor.context.register(donor.context.obj({P:page.ref})));
 const sources=new Map([['base',a],['donor',await donor.save({updateFieldAppearances:false})]]),refs=[insert(),insert(),base(0),base(1)],output=await assemblePdf(sources,refs),pdf=await PDFDocument.load(output);
 for(const index of [0,1])assert.equal(pdf.getPage(index).node.Resources().lookup(n('PieceInfo'),PDFDict).get(n('P')).toString(),pdf.getPage(index).ref.toString());
 donor.catalog.set(n('OCProperties'),donor.context.obj({OCGs:[]}));sources.set('donor',await donor.save({updateFieldAppearances:false}));await assert.rejects(assemblePdf(sources,refs),/layers/);
 donor.catalog.delete(n('OCProperties'));page.node.Resources().set(n('ForeignPage'),donor.getPage(1).ref);sources.set('donor',await donor.save({updateFieldAppearances:false}));await assert.rejects(assemblePdf(sources,refs),/cross-page|another page/);
});


test('an inserted reference can itself carry a replacement without importing either donor annotations',async()=>{
 const sources=new Map([['base',await fixture()],['donor',await fixture(true)]]);
 const pages=[insert({label:'R1-replaced',rotation:90,replacement:{sourceId:'donor',pageIndex:1}}),base(0),base(1)];
 const result=await materializeWorkspace(sources,pages,[]),pdf=await PDFDocument.load(result);assert.deepEqual(await texts(result),['REVISION 1','ORIGINAL 0','ORIGINAL 1']);assert.equal(pdf.getPage(0).getRotation().angle,180);assert.equal(pdf.getPage(0).node.has(n('Annots')),false);assert.equal(pdf.getPage(0).node.has(n('AA')),false);
 await reader(result,async r=>{assert.deepEqual(await r.getPageLabels(),['R1-replaced','A101','A102']);assert.equal((await r.getDestination('numeric'))[0],1);});
});
