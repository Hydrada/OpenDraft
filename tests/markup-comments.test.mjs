import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFNumber} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {validateMarkupComments,addMarkupComment,updateMarkupComment,deleteMarkupComment} from '../apps/opendraft/src/markup-comments.ts';
import {validateMarkups,applyMarkups} from '../apps/opendraft/src/annotations.ts';
import {WorkspaceHistory} from '../apps/opendraft/src/workspace-history.ts';

const time='2026-10-21T12:00:00.000Z',later='2026-10-21T13:00:00.000Z',last='2026-10-21T14:00:00.000Z';
const comment=(id,extra={})=>({id,author:'Reviewer',contents:`Comment ${id}`,createdAt:time,modifiedAt:time,...extra});
const mark=(id,extra={})=>({id,pageIndex:0,kind:'rectangle',points:[[40,50],[180,120]],color:[0.7,0.1,0.3],width:2,opacity:0.6,contents:`Review ${id}`,author:'Drawing author',status:'open',locked:false,createdAt:time,modifiedAt:time,...extra});
const layer={id:'review',name:'Review layer',visible:true,locked:false};
const threaded=()=>[comment('root'),comment('child',{parentId:'root'}),comment('grandchild',{parentId:'child'}),comment('separate')];

test('comment schema preserves Unicode and replies defensively, trims text and rejects malformed trees and dates',()=>{
 const input=[comment('root',{author:'  工程师  ',contents:'  Review café\n\t测量 😀  ',unexpected:'dropped'}),comment('child',{parentId:'root'})];
 const canonical=validateMarkupComments(input);assert.equal(canonical[0].author,'工程师');assert.equal(canonical[0].contents,'Review café\n\t测量 😀');assert.equal('unexpected' in canonical[0],false);
 canonical[0].contents='Changed';assert.equal(input[0].contents,'  Review café\n\t测量 😀  ');
 for(const value of [null,{},new Array(1),[null],[comment('bad/id')],[comment('a'),comment('a')],[comment('self',{parentId:'self'})],[comment('child',{parentId:'missing'})],[comment('a',{parentId:'b'}),comment('b',{parentId:'a'})],[comment('a',{author:' '})],[comment('a',{author:'a'.repeat(201)})],[comment('a',{author:'line\nname'})],[comment('a',{contents:'\t\n'})],[comment('a',{contents:'x'.repeat(10001)})],[comment('a',{contents:'bad\0text'})],[comment('a',{contents:'bad\uD800'})],[comment('a',{createdAt:'2026-02-30T00:00:00.000Z'})],[comment('a',{createdAt:'2026-10-21'})],[comment('a',{modifiedAt:'2026-10-20T00:00:00.000Z'})]])assert.throws(()=>validateMarkupComments(value));
 assert.equal(validateMarkupComments(Array.from({length:100},(_,i)=>comment(`c${i}`))).length,100);
 assert.throws(()=>validateMarkupComments(Array.from({length:101},(_,i)=>comment(`c${i}`))),/100/);
});

test('markup canonicalization enforces workspace comment IDs/count/text budgets without changing legacy shapes',()=>{
 const old=mark('legacy');assert.deepEqual(validateMarkups([old],1),[old]);
 const source=[mark('a',{comments:threaded()})],copy=validateMarkups(source,1);copy[0].comments[1].author='Other';assert.equal(source[0].comments[1].author,'Reviewer');
 assert.throws(()=>validateMarkups([mark('a',{comments:[comment('same')]}),mark('b',{comments:[comment('same')]})],1),/Duplicate comment/);
 const many=Array.from({length:51},(_,i)=>mark(`m${i}`,{comments:Array.from({length:100},(_,j)=>comment(`c${i}-${j}`))}));
 assert.equal(validateMarkups(many.slice(0,50),1).length,50);assert.throws(()=>validateMarkups(many,1),/budget/);
 const long=Array.from({length:3},(_,i)=>mark(`long${i}`,{comments:Array.from({length:100},(_,j)=>comment(`long${i}-${j}`,{contents:'x'.repeat(7000)}))}));
 assert.throws(()=>validateMarkups(long,1),/budget/);
});

test('comment CRUD edits only its owning group member and deletes complete reply subtrees atomically',()=>{
 const source=[mark('one',{groupId:'g',layerId:'review',comments:threaded()}),mark('two',{groupId:'g',layerId:'review'})],before=structuredClone(source);
 const added=addMarkupComment(source,'one',comment('new',{parentId:'child',createdAt:later,modifiedAt:later}),1,[layer]);
 assert.equal(added[0].comments.length,5);assert.equal(added[0].modifiedAt,later);assert.deepEqual(added[1],source[1]);assert.deepEqual(added[0].points,source[0].points);assert.equal(added[0].groupId,'g');
 const edited=updateMarkupComment(added,'one','root',{author:' Lead ',contents:' Updated conclusion '},last,1,[layer]);
 assert.equal(edited[0].comments[0].author,'Lead');assert.equal(edited[0].comments[0].contents,'Updated conclusion');assert.equal(edited[0].comments[0].createdAt,time);assert.equal(edited[0].comments[0].modifiedAt,last);
 const deleted=deleteMarkupComment(edited,'one','child',last,1,[layer]);assert.deepEqual(deleted[0].comments.map(c=>c.id),['root','separate']);assert.deepEqual(deleted[1],source[1]);
 assert.deepEqual(source,before);
 const pages=[{sourceId:'s',pageIndex:0,rotation:0}],history=new WorkspaceHistory(pages,source,undefined,[layer]);
 history.commit(pages,edited,undefined,[layer]);history.commit(pages,deleted,undefined,[layer]);history.undo();assert.deepEqual(history.markups,edited);history.undo();assert.deepEqual(history.markups,source);history.redo();assert.deepEqual(history.markups,edited);
 const snapshot=history.markups;snapshot[0].comments[0].contents='Outside mutation';assert.equal(history.markups[0].comments[0].contents,'Updated conclusion');
});

test('annotation/layer locks, stale IDs, bad edits and backdated actions reject without partial changes',()=>{
 const source=[mark('one',{layerId:'review',comments:threaded()})],before=structuredClone(source);
 for(const operation of [
  marks=>addMarkupComment(marks,'one',comment('added',{modifiedAt:later}),1,[layer]),
  marks=>updateMarkupComment(marks,'one','root',{author:'New',contents:'New'},later,1,[layer]),
  marks=>deleteMarkupComment(marks,'one','root',later,1,[layer]),
 ])assert.throws(()=>operation([{...source[0],locked:true}]),/Unlock/);
 for(const operation of [
  ()=>addMarkupComment(source,'one',comment('added'),1,[{...layer,locked:true}]),
  ()=>updateMarkupComment(source,'one','root',{author:'New',contents:'New'},later,1,[{...layer,locked:true}]),
  ()=>deleteMarkupComment(source,'one','root',later,1,[{...layer,locked:true}]),
 ])assert.throws(operation,/layer/);
 assert.throws(()=>addMarkupComment(source,'missing',comment('new'),1,[layer]),/existing/);
 assert.throws(()=>addMarkupComment(source,'one',comment('root'),1,[layer]),/duplicate/);
 assert.throws(()=>updateMarkupComment(source,'one','missing',{author:'New',contents:'New'},later,1,[layer]),/no longer/);
 assert.throws(()=>deleteMarkupComment(source,'one','missing',later,1,[layer]),/no longer/);
 assert.throws(()=>updateMarkupComment(source,'one','root',{author:'New',contents:'New',parentId:'separate'},later,1,[layer]),/only/);
 assert.throws(()=>deleteMarkupComment(source,'one','root','bad-time',1,[layer]),/timestamp/);
 assert.throws(()=>addMarkupComment([{...source[0],modifiedAt:last}],'one',comment('backdated'),1,[layer]),/precedes/);
 assert.deepEqual(source,before);
});

async function base(){const pdf=await PDFDocument.create();pdf.setTitle('Original construction sheet');const page=pdf.addPage([240,200]);page.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[0,0,10,10],NM:'foreign',Contents:'Foreign retained',F:32})));return pdf.save();}
async function parsed(bytes){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{const pdf=await task.promise,page=await pdf.getPage(1),annotations=await page.getAnnotations({intent:'any'}),canvas=createCanvas(240,200);await page.render({canvas,viewport:page.getViewport({scale:1})}).promise;return {annotations,pixels:canvas.getContext('2d').getImageData(0,0,240,200).data};}finally{await task.destroy();}}

test('PDF comment replies retain Unicode, same-page IRT chains, group relationships, locks and source metadata',async()=>{
 const bytes=await base(),before=bytes.slice(),marks=[mark('primary',{groupId:'g',layerId:'review',comments:[comment('root',{author:'工程师',contents:'核对 😀'}),comment('reply',{parentId:'root'})]}),mark('subordinate',{groupId:'g',layerId:'review',comments:[comment('subreply')]})];
 const saved=await applyMarkups(bytes,marks,{layers:[{...layer,locked:true}]}),pdf=await PDFDocument.load(saved),page=pdf.getPage(0),array=page.node.Annots();
 assert.equal(array.size(),6);assert.equal(pdf.getTitle(),'Original construction sheet');assert.deepEqual(bytes,before);
 const entries=array.asArray().map(ref=>({ref,dict:pdf.context.lookup(ref,PDFDict)}));
 const find=id=>entries.find(item=>item.dict.lookup(PDFName.of('NM')).decodeText()===id);
 const primary=find('opendraft:primary'),sub=find('opendraft:subordinate'),root=find('opendraft:comment:root'),reply=find('opendraft:comment:reply'),subreply=find('opendraft:comment:subreply');
 assert.equal(sub.dict.get(PDFName.of('IRT')).toString(),primary.ref.toString());assert.equal(sub.dict.get(PDFName.of('RT')).toString(),'/Group');
 for(const [item,parent] of [[root,primary],[reply,root],[subreply,sub]]){
  assert.equal(item.dict.get(PDFName.of('IRT')).toString(),parent.ref.toString());assert.equal(item.dict.get(PDFName.of('RT')).toString(),'/R');assert.equal(item.dict.get(PDFName.of('P')).toString(),page.ref.toString());assert.equal(item.dict.get(PDFName.of('Subtype')).toString(),'/Text');
  assert.equal(item.dict.lookup(PDFName.of('F'),PDFNumber).asNumber(),32+128+512);assert.equal(item.dict.get(PDFName.of('OC')).toString(),primary.dict.get(PDFName.of('OC')).toString());
 }
 assert.equal(root.dict.lookup(PDFName.of('T')).decodeText(),'工程师');assert.equal(root.dict.lookup(PDFName.of('Contents')).decodeText(),'核对 😀');
 const independent=await parsed(saved),decoded=independent.annotations.find(a=>a.contentsObj?.str==='核对 😀');assert.ok(decoded);assert.equal(decoded.titleObj.str,'工程师');assert.equal(decoded.replyType,'R');assert.ok(decoded.inReplyTo);
 const flat=await PDFDocument.load(await applyMarkups(bytes,marks,{layers:[layer],flatten:true}));assert.equal(flat.getPage(0).node.Annots().size(),1);assert.equal(flat.getTitle(),'Original construction sheet');
});

test('thread metadata never draws standalone icons or changes visible/flattened annotation pixels',async()=>{
 const bytes=await base(),plain=[mark('one')],discussed=[mark('one',{comments:threaded()})];
 const reference=await parsed(await applyMarkups(bytes,plain)),withComments=await parsed(await applyMarkups(bytes,discussed));assert.deepEqual(withComments.pixels,reference.pixels);
 const flattened=await parsed(await applyMarkups(bytes,discussed,{flatten:true}));let sum=0;for(let i=0;i<reference.pixels.length;i++)sum+=Math.abs(reference.pixels[i]-flattened.pixels[i]);assert.ok(sum/reference.pixels.length<0.2);
});
