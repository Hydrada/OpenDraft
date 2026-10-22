import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFHexString,PDFString} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {materializeWorkspace} from '../apps/opendraft/src/workspace-export.ts';

async function fixture(){
  const doc=await PDFDocument.create(),page=doc.addPage([300,400]);doc.addPage([400,300]);
  await doc.attach(new TextEncoder().encode('Preserve attachment'),'note.txt');
  const outlines=doc.context.obj({Type:'Outlines',Count:1}),outlineRef=doc.context.register(outlines);
  const item=doc.context.register(doc.context.obj({Title:PDFHexString.fromText('Keep bookmark'),Parent:outlineRef,Dest:[page.ref,PDFName.of('Fit')]}));
  outlines.set(PDFName.of('First'),item);outlines.set(PDFName.of('Last'),item);doc.catalog.set(PDFName.of('Outlines'),outlineRef);
  const layer=doc.context.register(doc.context.obj({Type:'OCG',Name:PDFString.of('Keep layer')}));
  doc.catalog.set(PDFName.of('OCProperties'),doc.context.obj({OCGs:[layer],D:{Order:[layer],ON:[layer]}}));
  doc.getForm().createTextField('asset').setText('A101');
  return doc.save();
}
const pages=()=>[{sourceId:'A',pageIndex:0,rotation:0},{sourceId:'A',pageIndex:1,rotation:0}];
const markup=()=>({id:'review-1',pageIndex:0,kind:'rectangle',points:[[20,20],[100,100]],color:[1,0,0],width:2,opacity:1,contents:'Review',author:'Tester',status:'open',locked:false,createdAt:'2026-10-21T12:00:00.000Z',modifiedAt:'2026-10-21T12:00:00.000Z'});

test('unchanged export retains identical bytes; rotation and markup retain document navigation and forms',async()=>{
  const bytes=await fixture(),sources=new Map([['A',bytes]]),before=bytes.slice();
  assert.deepEqual(await materializeWorkspace(sources,pages(),[]),bytes);
  const state=pages();state[0].rotation=90;
  const output=await materializeWorkspace(sources,state,[markup()]);
  const parsed=await PDFDocument.load(output);
  assert.equal(parsed.getForm().getTextField('asset').getText(),'A101');
  const task=getDocument({data:output.slice()});
  try{
    const pdf=await task.promise;
    assert.equal((await pdf.getOutline())[0].title,'Keep bookmark');
    assert.equal((await pdf.getAttachments()).size,1);
    assert.equal([...await pdf.getOptionalContentConfig()].length,1);
    assert.equal((await pdf.getPage(1)).rotate,90);
    assert.equal((await (await pdf.getPage(1)).getAnnotations()).some(a=>a.subtype==='Square'),true);
  }finally{await task.destroy();}
  assert.deepEqual(bytes,before);
});

test('repeated materialization from original sources never duplicates authored annotations',async()=>{
  const sources=new Map([['A',await fixture()]]);
  for(let i=0;i<2;i++){
    const output=await materializeWorkspace(sources,pages(),[{...markup(),contents:`Revision ${i}`}]);
    const task=getDocument({data:output});
    try{const pdf=await task.promise;const annotations=await (await pdf.getPage(1)).getAnnotations();assert.equal(annotations.filter(a=>a.subtype==='Square').length,1);}
    finally{await task.destroy();}
  }
});

test('rewriting signed/certified input is refused while untouched download remains possible',async()=>{
  const doc=await PDFDocument.create();doc.addPage([300,400]);
  const signature=doc.context.register(doc.context.obj({Type:'Sig',ByteRange:[0,100,200,100],Contents:PDFHexString.of('00')}));
  doc.catalog.set(PDFName.of('Perms'),doc.context.obj({DocMDP:signature}));
  const bytes=await doc.save(),source=new Map([['A',bytes]]),refs=[{sourceId:'A',pageIndex:0,rotation:0}];
  assert.deepEqual(await materializeWorkspace(source,refs,[]),bytes);
  await assert.rejects(materializeWorkspace(source,[{...refs[0],rotation:90}],[]),/sign|certif|protect/i);
});
