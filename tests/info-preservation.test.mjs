import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFHexString,PDFString,PDFDict} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {exportPdf} from '../apps/opendraft/src/document.ts';
import {applyMarkups} from '../apps/opendraft/src/annotations.ts';
import {materializeWorkspace} from '../apps/opendraft/src/workspace-export.ts';

const mark={id:'info-check',pageIndex:0,kind:'rectangle',points:[[20,20],[80,80]],color:[1,0,0],width:2,opacity:1,contents:'Review',author:'Reviewer',status:'open',locked:false,createdAt:'2026-10-21T12:00:00.000Z',modifiedAt:'2026-10-21T12:00:00.000Z'};
async function fixture(withInfo=true) {
  const doc=await PDFDocument.create({updateMetadata:false});doc.addPage([300,400]);
  if(withInfo) {
    const info=doc.context.obj({
      Title:PDFHexString.fromText('Plan — Montréal'),Author:PDFString.of('Authorized source'),
      Subject:PDFString.of('Drawing register'),Keywords:PDFString.of('A101, construction'),
      Creator:PDFString.of('Original authoring tool'),Producer:PDFString.of('Original producer'),
      CreationDate:PDFString.of('D:20010203040506Z'),ModDate:PDFString.of('D:20020304050607Z'),
      ProjectCode:PDFString.of('C-102'),
    });
    doc.context.trailerInfo.Info=doc.context.register(info);
  }
  const xml='<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original XMP title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const metadata=doc.context.stream(new TextEncoder().encode(xml),{Type:'Metadata',Subtype:'XML'});
  doc.catalog.set(PDFName.of('Metadata'),doc.context.register(metadata));
  return doc.save();
}
async function infoEntries(bytes) {
  const doc=await PDFDocument.load(bytes,{updateMetadata:false});
  const info=doc.context.lookup(doc.context.trailerInfo.Info);
  return info instanceof PDFDict ? info.entries().map(([key,value])=>[key.toString(),value.toString()]).sort() : null;
}
async function independentMetadata(bytes) {
  const task=getDocument({data:bytes.slice()});
  try {const pdf=await task.promise;const result=await pdf.getMetadata();return {info:result.info,xmp:result.metadata?.getRaw()};}
  finally {await task.destroy();}
}
test('rotation, markup and flatten preserve standard/custom Info and independent-reader XMP',async()=>{
  const source=await fixture(),before=source.slice(),expected=await infoEntries(source),metadata=await independentMetadata(source);
  const pages=[{sourceId:'source',pageIndex:0,rotation:90}];
  const outputs=[
    await exportPdf(source,new Map([[1,90]])),
    await applyMarkups(source,[mark]),
    await applyMarkups(source,[mark],{flatten:true}),
    await materializeWorkspace(new Map([['source',source]]),pages,[mark]),
  ];
  for(const output of outputs) {
    assert.deepEqual(await infoEntries(output),expected);
    const parsed=await independentMetadata(output);
    for(const key of ['Title','Author','Subject','Keywords','Creator','Producer','CreationDate','ModDate','Custom'])
      assert.deepEqual(parsed.info[key],metadata.info[key]);
    assert.equal(parsed.xmp,metadata.xmp);
    assert.ok(parsed.xmp.includes('Original XMP title'));
  }
  assert.deepEqual(source,before);
});
test('editing a source without Info does not invent producer or date entries',async()=>{
  const source=await fixture(false);
  assert.equal(await infoEntries(source),null);
  for(const output of [await exportPdf(source,new Map([[1,90]])),await applyMarkups(source,[mark]),await applyMarkups(source,[mark],{flatten:true})])
    assert.equal(await infoEntries(output),null);
});
