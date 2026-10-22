import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { drawingFixture } from './fixture.mjs';
import { assemblePdf, PageHistory } from '../apps/opendraft/src/organization.ts';

const ref=(sourceId,pageIndex,rotation=0)=>({sourceId,pageIndex,rotation});
async function readPages(bytes) {
  const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});
  try {
    const pdf=await task.promise, pages=[];
    for(let i=1;i<=pdf.numPages;i++) {
      const page=await pdf.getPage(i);
      pages.push({rotation:page.rotate,text:(await page.getTextContent()).items.map(item=>item.str??'').join(' '),view:page.view});
    }
    return pages;
  } finally { await task.destroy(); }
}

test('organization reorders, duplicates and extracts pages with original rotation and text',async()=>{
  const bytes=await drawingFixture(), before=bytes.slice();
  const output=await assemblePdf(new Map([['A',bytes]]),[ref('A',1,-90),ref('A',0,90),ref('A',1,90)]);
  const pages=await readPages(output);
  assert.deepEqual(pages.map(p=>p.rotation),[0,90,180]);
  assert.deepEqual(pages.map(p=>p.text),['Valve schedule B202','OpenDraft synthetic drawing A101','Valve schedule B202']);
  assert.deepEqual(pages.map(p=>p.view),[[0,0,792,612],[0,0,612,792],[0,0,792,612]]);
  assert.deepEqual(bytes,before);
  assert.equal((await readPages(await assemblePdf(new Map([['A',bytes]]),[ref('A',1)]))).length,1);
});

test('organization merges interleaved independent sources without altering originals',async()=>{
  const a=await drawingFixture();
  const second=await PDFDocument.create();
  const font=await second.embedFont(StandardFonts.Helvetica);
  second.addPage([400,500]).drawText('Independent detail C303',{x:20,y:450,font});
  const b=await second.save(), originals=[a.slice(),b.slice()];
  const pages=await readPages(await assemblePdf(new Map([['A',a],['B',b]]),[ref('A',1),ref('B',0,270),ref('A',0)]));
  assert.deepEqual(pages.map(p=>p.text),['Valve schedule B202','Independent detail C303','OpenDraft synthetic drawing A101']);
  assert.deepEqual(pages.map(p=>p.rotation),[90,270,0]);
  assert.deepEqual([a,b],originals);
});

test('organization rejects missing, corrupt, out-of-range and malformed references',async()=>{
  const sources=new Map([['A',await drawingFixture()],['bad',new TextEncoder().encode('invalid PDF')]]);
  for(const pages of [[],[ref('missing',0)],[ref('A',2)],[ref('A',-1)],[ref('A',0.5)],[ref('A',0,45)],[ref('',0)],[ref('A',0,Infinity)],[ref('bad',0)]]) await assert.rejects(assemblePdf(sources,pages));
});

test('organization refuses encryption-marked PDFs instead of bypassing protection',async()=>{
  // A synthetic Encrypt trailer tests the library guard, not cipher interoperability.
  const pdf=await PDFDocument.create();pdf.addPage();
  pdf.context.trailerInfo.Encrypt=pdf.context.register(pdf.context.obj({Filter:'Standard'}));
  const bytes=await pdf.save({useObjectStreams:false});
  await assert.rejects(assemblePdf(new Map([['protected',bytes]]),[ref('protected',0)]),/encrypted/i);
});

test('history isolates caller state, supports undo/redo and replaces redo branch',()=>{
  const initial=[ref('A',0),ref('A',1)];
  const history=new PageHistory(initial);
  initial[0].pageIndex=99;
  const snapshot=history.pages;snapshot[0].rotation=90;snapshot.pop();
  assert.deepEqual(history.pages,[ref('A',0),ref('A',1)]);
  history.commit([ref('A',1),ref('A',0)]);history.undo();
  assert.equal(history.canRedo,true);assert.equal(history.canUndo,false);
  history.redo();assert.equal(history.pages[0].pageIndex,1);
  history.undo();history.commit([ref('A',0)]);
  assert.equal(history.canRedo,false);
  assert.throws(()=>history.commit([]),/at least one/);
  assert.deepEqual(history.pages,[ref('A',0)]);
});

test('history retains at most 100 undo commands and ignores equivalent commits',()=>{
  const history=new PageHistory([ref('A',0)]);
  history.commit([ref('A',0,360)]);assert.equal(history.canUndo,false);
  for(let i=1;i<=120;i++) history.commit([ref('A',i)]);
  let undos=0;while(history.canUndo){history.undo();undos++;}
  assert.equal(undos,100);assert.equal(history.pages[0].pageIndex,20);
  history.undo();assert.equal(history.pages[0].pageIndex,20);
});
