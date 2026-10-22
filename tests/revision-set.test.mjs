import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFString,PDFNumber,StandardFonts,degrees,decodePDFRawStream} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {unzipSync,strFromU8} from 'fflate';
import {runRevisionSet,REVISION_SET_LIMITS} from '../apps/opendraft/src/revision-set.ts';
const now='2026-10-21T19:00:00.000Z',n=PDFName.of;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function source(title='BASE',settings={}){
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.setTitle(title);
 for(let i=0;i<2;i++){
  const page=pdf.addPage(settings.small?[50,60]:[300,400]);page.drawText(`${title} ${i}`,{x:20,y:80,font,size:12});
  if(settings.crop)page.setCropBox(...settings.crop);if(settings.rotation)page.setRotation(degrees(settings.rotation));if(settings.unit)page.node.set(n('UserUnit'),PDFNumber.of(settings.unit));
  page.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],Contents:PDFString.of(`${title} COMMENT`),P:page.ref})));
 }
 pdf.catalog.set(n('PageLabels'),pdf.context.obj({Nums:[0,{P:PDFString.of('A101')},1,{P:PDFString.of('B202')}]}));
 const pages=pdf.getPages(),outlines=pdf.context.obj({Type:'Outlines',Count:1}),outlineRef=pdf.context.register(outlines),item=pdf.context.register(pdf.context.obj({Title:PDFString.of('First base page'),Parent:outlineRef,Dest:[pages[0].ref,n('Fit')]}));outlines.set(n('First'),item);outlines.set(n('Last'),item);pdf.catalog.set(n('Outlines'),outlineRef);pdf.catalog.set(n('OpenAction'),pdf.context.obj([0,n('Fit')]));
 if(settings.signed)pdf.context.register(pdf.context.obj({Type:'Sig',ByteRange:[0,10,20,30]}));
 if(settings.layers)pdf.catalog.set(n('OCProperties'),pdf.context.obj({OCGs:[]}));
 const bytes=await pdf.save({updateFieldAppearances:false});return{name:settings.name??`${title}.pdf`,bytes,sha256:digest(bytes),pageCount:2,labels:['A101','B202']};
}
function plan(base,revision,operation='replace',extra={}){return{schema:'opendraft.revision-plan',version:1,createdAt:now,base:{sha256:base.sha256,pageCount:base.pageCount},revision:{sha256:revision.sha256,pageCount:revision.pageCount},operation,markupPolicy:'retain',reason:'Reviewed authorized fixture revision',pairs:[{basePage:1,revisionPage:1}],...extra};}
async function read(bytes,inspect){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{return await inspect(await task.promise);}finally{await task.destroy();}}
async function texts(bytes){return read(bytes,async pdf=>{const values=[];for(let i=1;i<=pdf.numPages;i++)values.push((await(await pdf.getPage(i)).getTextContent()).items.map(x=>x.str??'').join(' '));return values;});}

test('two independent jobs retain base annotations/catalog, record geometry failure and archive exact output evidence',async()=>{
 const base=await source(),revision=await source('REVISION'),bad=await source('BAD',{unit:2}),before=[base.bytes.slice(),revision.bytes.slice(),bad.bytes.slice()];
 const jobs=[{id:'good',base,revision,plan:plan(base,revision)},{id:'bad',base,revision:bad,plan:plan(base,bad)}],progress=[];
 const {zip,manifest}=await runRevisionSet(jobs,now,undefined,(done,total)=>progress.push([done,total])),files=unzipSync(zip);
 assert.deepEqual(progress,[[1,2],[2,2]]);assert.deepEqual(manifest.results.map(r=>r.status),['succeeded','failed']);assert.match(manifest.results[1].error,/geometry/);assert.equal(manifest.results[0].outputPath,'PDFs/0001.pdf');assert.equal(files['PDFs/0002.pdf'],undefined);assert.deepEqual(Object.keys(files).sort(),['PDFs/0001.pdf','manifest.json','summary.csv']);assert.deepEqual(JSON.parse(strFromU8(files['manifest.json'])),manifest);
 const good=manifest.results[0],bytes=files[good.outputPath];assert.equal(digest(bytes),good.outputSha256);assert.equal(good.outputBytes,bytes.length);assert.equal(good.outputPageCount,2);assert.deepEqual(good.unmatchedBase,[2]);assert.deepEqual(good.unmatchedRevision,[2]);assert.equal(good.journal.clearedMeasurements,0);assert.equal(good.journal.clearedScales,0);
 assert.deepEqual(await texts(bytes),['REVISION 0','BASE 1']);const pdf=await PDFDocument.load(bytes),original=await PDFDocument.load(base.bytes);assert.equal(pdf.getPage(0).ref.toString(),original.getPage(0).ref.toString());const comments=pdf.getPage(0).node.lookup(n('Annots'),PDFArray).asArray().map(ref=>pdf.context.lookup(ref,PDFDict).get(n('Contents'))?.decodeText());assert.deepEqual(comments,['BASE COMMENT']);assert.equal(pdf.getTitle(),'BASE');assert.ok(pdf.catalog.has(n('Outlines')));assert.deepEqual([base.bytes,revision.bytes,bad.bytes],before);
});

test('insert-before uses donor content only, stamps old page SUPERSEDED and leaves navigation on old page',async()=>{
 const base=await source(),revision=await source('REVISION',{crop:[10,20,250,320],rotation:90,unit:2}),result=await runRevisionSet([{id:'insert',base,revision,plan:plan(base,revision,'insert-before')}],now),files=unzipSync(result.zip),bytes=files['PDFs/0001.pdf'];
 assert.equal(result.manifest.results[0].status,'succeeded');assert.deepEqual(await texts(bytes),['REVISION 0','BASE 0','BASE 1']);const pdf=await PDFDocument.load(bytes),inserted=pdf.getPage(0),old=pdf.getPage(1);assert.equal(inserted.node.has(n('Annots')),false);assert.equal(inserted.getRotation().angle,90);assert.equal(inserted.node.lookup(n('UserUnit'),PDFNumber).asNumber(),2);
 const annots=old.node.lookup(n('Annots'),PDFArray).asArray().map(ref=>pdf.context.lookup(ref,PDFDict)),stamp=annots.find(a=>a.get(n('Subtype'))?.toString()==='/Stamp');assert.equal(stamp.get(n('Contents')).decodeText(),'SUPERSEDED');assert.equal(stamp.get(n('Name')).toString(),'/Draft');const appearance=stamp.lookup(n('AP'),PDFDict).lookup(n('N'));assert.ok(Buffer.from(decodePDFRawStream(appearance).decode()).toString().includes(Buffer.from('SUPERSEDED').toString('hex').toUpperCase()));
 assert.equal(pdf.catalog.lookup(n('OpenAction'),PDFArray).lookup(0).asNumber(),1);await read(bytes,async r=>{assert.deepEqual(await r.getPageLabels(),['A101','A101','B202']);assert.equal(await r.getPageIndex((await r.getOutline())[0].dest[0]),1);});
});

test('all-failed set still exports explicit failure manifest and summary without PDF entries',async()=>{
 const base=await source(),revision=await source('SIGNED',{signed:true}),result=await runRevisionSet([{id:'blocked',base,revision,plan:plan(base,revision)}],now),files=unzipSync(result.zip);assert.equal(result.manifest.succeeded,0);assert.equal(result.manifest.failed,1);assert.match(result.manifest.results[0].error,/signature|blocked/i);assert.deepEqual(Object.keys(files).sort(),['manifest.json','summary.csv']);
});

test('stale hash or plan binding anywhere rejects whole set before any job progress or parse',async()=>{
 const base=await source(),revision=await source('REVISION'),valid={id:'first',base,revision,plan:plan(base,revision)},stale=structuredClone(valid);stale.id='second';stale.base.bytes[0]^=1;let progress=0;await assert.rejects(runRevisionSet([valid,stale],now,undefined,()=>progress++),/changed after review/);assert.equal(progress,0);
 const wrong=structuredClone(valid);wrong.plan.base.sha256='0'.repeat(64);await assert.rejects(runRevisionSet([wrong],now),/sources do not match/);
});

test('source bytes, labels and canonical plans are copied before caller mutation during first await',async()=>{
 const base=await source(),revision=await source('REVISION'),job={id:'original',base,revision,plan:plan(base,revision)};const running=runRevisionSet([job],now);base.bytes.fill(0);revision.bytes.fill(0);revision.labels[0]='wrong';job.plan.pairs[0].revisionPage=2;job.plan.reason='changed';job.id='changed';const result=await running,files=unzipSync(result.zip);assert.equal(result.manifest.results[0].id,'original');assert.equal(result.manifest.results[0].plan.reason,'Reviewed authorized fixture revision');assert.deepEqual(await texts(files['PDFs/0001.pdf']),['REVISION 0','BASE 1']);
});

test('pre-abort and cancellation between jobs return no partial archive',async()=>{
 const base=await source(),revision=await source('REVISION'),job={id:'first',base,revision,plan:plan(base,revision)},controller=new AbortController();controller.abort();await assert.rejects(runRevisionSet([job],now,controller.signal),{name:'AbortError'});
 const during=new AbortController();let progressed=0;await assert.rejects(runRevisionSet([job,{...job,id:'second'}],now,during.signal,()=>{progressed++;during.abort();}),{name:'AbortError'});assert.equal(progressed,1);
});

test('job count, source and metadata limits reject before copying or parsing',async()=>{
 const base=await source(),revision=await source('REVISION'),job={id:'first',base,revision,plan:plan(base,revision)};
 await assert.rejects(runRevisionSet([],now),/1–20/);await assert.rejects(runRevisionSet(Array.from({length:21},(_,i)=>({...job,id:String(i)})),now),/1–20/);await assert.rejects(runRevisionSet([job,job],now),/unique/);await assert.rejects(runRevisionSet([{...job,base:{...base,labels:[]}}],now),/metadata/);await assert.rejects(runRevisionSet([job],'yesterday'),/timestamp/);
 const large=new Uint8Array(REVISION_SET_LIMITS.maxSourceBytes);const padded={...base,bytes:large};const largeJob={...job,base:padded,revision:padded};await assert.rejects(runRevisionSet([largeJob,{...largeJob,id:'second'},{...largeJob,id:'third'}],now),/256 MiB/);
});

test('actual page-count mismatch, crop differences and layer donors become explicit per-job failures',async()=>{
 const base=await source(),revision=await source('REVISION'),forged={...base,pageCount:1,labels:['A101']},crop=await source('CROP',{crop:[20,20,250,300]}),layers=await source('LAYERS',{layers:true});const jobs=[{id:'count',base:forged,revision,plan:plan(forged,revision)},{id:'crop',base,revision:crop,plan:plan(base,crop,'replace',{markupPolicy:'remove'})},{id:'layers',base,revision:layers,plan:plan(base,layers,'insert-before')}];const result=await runRevisionSet(jobs,now);assert.deepEqual(result.manifest.results.map(r=>r.status),['failed','failed','failed']);assert.match(result.manifest.results[0].error,/page counts/);assert.match(result.manifest.results[1].error,/geometry/);assert.match(result.manifest.results[2].error,/layers/);
});

test('numeric safe ZIP paths and quoted CSV cannot become filenames or spreadsheet formulas',async()=>{
 const base=await source('BASE',{name:' =HYPERLINK("evil").pdf'}),revision=await source('REVISION',{name:'../../revision.pdf'}),job={id:'\t+SUM(1)',base,revision,plan:plan(base,revision)},result=await runRevisionSet([job],now),files=unzipSync(result.zip),csv=strFromU8(files['summary.csv']);assert.deepEqual(Object.keys(files).sort(),['PDFs/0001.pdf','manifest.json','summary.csv']);assert.ok(csv.includes('"\'\t+SUM(1)"'));assert.ok(csv.includes('"\' =HYPERLINK(""evil"").pdf"'));assert.ok(csv.includes('"../../revision.pdf"'));
});
