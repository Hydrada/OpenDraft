import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readDocumentNavigation, sanitizedHttpUrl, safeAttachmentFilename } from '../apps/opendraft/src/metadata.ts';

test('metadata resolves actual PDF bookmarks, attachment and optional-content layer',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage();
  await pdf.attach(new TextEncoder().encode('Authorized synthetic note'),'../notes.txt');
  const outline=pdf.context.obj({Type:'Outlines',Count:1});
  const outlineRef=pdf.context.register(outline);
  const item=pdf.context.obj({Title:PDFHexString.fromText('Sheet A101'),Parent:outlineRef,Dest:[page.ref,PDFName.of('Fit')]});
  const itemRef=pdf.context.register(item);outline.set(PDFName.of('First'),itemRef);outline.set(PDFName.of('Last'),itemRef);
  pdf.catalog.set(PDFName.of('Outlines'),outlineRef);
  const layer=pdf.context.register(pdf.context.obj({Type:'OCG',Name:PDFString.of('Dimensions')}));
  pdf.catalog.set(PDFName.of('OCProperties'),pdf.context.obj({OCGs:[layer],D:{Order:[layer],ON:[layer]}}));
  const task=getDocument({data:await pdf.save()});
  try {
    const navigation=await readDocumentNavigation(await task.promise);
    assert.deepEqual(navigation.bookmarks,[{title:'Sheet A101',pageNumber:1,url:null,children:[]}]);
    assert.equal(navigation.attachments.length,1);
    assert.equal(navigation.attachments[0].filename,'notes.txt');
    assert.equal(new TextDecoder().decode(navigation.attachments[0].bytes),'Authorized synthetic note');
    assert.equal(navigation.attachments[0].error,null);
    assert.equal(navigation.layers.length,1);assert.equal(navigation.layers[0].name,'Dimensions');assert.equal(navigation.layers[0].visible,true);
    navigation.optionalContentConfig.setVisibility(navigation.layers[0].id,false);
    assert.equal(navigation.optionalContentConfig.getGroup(navigation.layers[0].id).visible,false);
  } finally {await task.destroy();}
});

test('external URL and filenames are constrained for explicit user downloads/navigation',()=>{
  assert.equal(sanitizedHttpUrl('https://example.org/drawing?q=1'),'https://example.org/drawing?q=1');
  for(const url of ['javascript:alert(1)','data:text/html,hi','file:///C:/secret','https://user:pass@example.com','//example.com','https://example.com/\nscript'])assert.equal(sanitizedHttpUrl(url),null);
  assert.equal(safeAttachmentFilename('C:\\secret\\CON.txt'),'_CON.txt');
  assert.equal(safeAttachmentFilename('../../test?.txt'),'test_.txt');
  assert.equal(safeAttachmentFilename('..'),'attachment.bin');
});

test('named/broken destinations and hostile URLs remain inert; oversize attachments rejected',async()=>{
  const big=new Uint8Array(25*1024*1024+1),small=new Uint8Array([1,2]);
  const pdf={numPages:2,getOutline:async()=>[{title:'Named',dest:'sheet',url:'javascript:alert(1)',items:[{title:'Broken',dest:[{num:404}],url:'https://example.org/',items:[]}]}],getDestination:async()=>[1],getPageIndex:async()=>{throw Error('missing')},getAttachments:async()=>new Map([['large',{filename:'large.bin',content:big}],['small',{filename:'safe.bin',content:small}]]),getOptionalContentConfig:async()=>new Map()};
  const result=await readDocumentNavigation(pdf);
  assert.equal(result.bookmarks[0].pageNumber,2);assert.equal(result.bookmarks[0].url,null);
  assert.equal(result.bookmarks[0].children[0].pageNumber,null);
  assert.equal(result.attachments[0].bytes,null);assert.match(result.attachments[0].error,/25 MB/);
  result.attachments[1].bytes[0]=9;assert.equal(small[0],1);
});

test('attachment aggregate limit rejects content beyond 100 MB without blocking smaller accepted entries',async()=>{
  const block=new Uint8Array(25*1024*1024);
  const entries=new Map(Array.from({length:4},(_,i)=>[String(i),{filename:`block-${i}.bin`,content:block}]));
  entries.set('overflow',{filename:'overflow.bin',content:new Uint8Array([1])});
  const pdf={numPages:1,getOutline:async()=>null,getAttachments:async()=>entries,getOptionalContentConfig:async()=>new Map()};
  const result=await readDocumentNavigation(pdf);
  assert.equal(result.attachments.slice(0,4).every(item=>item.bytes?.byteLength===block.byteLength),true);
  assert.equal(result.attachments[4].bytes,null);assert.match(result.attachments[4].error,/100 MB/);
});
