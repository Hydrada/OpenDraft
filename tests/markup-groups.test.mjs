import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PDFDocument,PDFName,PDFDict} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {validateMarkups,applyMarkups} from '../apps/opendraft/src/annotations.ts';
import {groupMarkups,ungroupMarkups,updateMarkupSelection,lockMarkupSelection,translateMarkupSelection,deleteMarkupSelection} from '../apps/opendraft/src/markup-groups.ts';
import {WorkspaceHistory} from '../apps/opendraft/src/workspace-history.ts';
const time='2026-10-21T12:00:00.000Z',later='2026-10-21T13:00:00.000Z';
const mark=(id,extra={})=>({id,pageIndex:0,kind:'rectangle',points:[[40,50],[180,120]],color:[0.7,0.1,0.3],width:2,opacity:0.6,contents:`Review ${id}`,author:'Reviewer',status:'open',locked:false,createdAt:time,modifiedAt:time,...extra});
const source=()=>[mark('a'),mark('b',{kind:'callout',points:[[180,180],[340,250]],callout:[[100,100],[180,210]]}),mark('c',{pageIndex:1})];
const group=()=>groupMarkups(source(),['a','b'],'group-one',2,later);
async function base(){const p=await PDFDocument.create();p.setTitle('Original drawing');p.addPage([400,400]);p.addPage([400,400]);return p.save();}
async function pixels(bytes){const task=getDocument({data:bytes.slice(),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});try{const page=await(await task.promise).getPage(1),viewport=page.getViewport({scale:1}),canvas=createCanvas(400,400);await page.render({canvas,viewport}).promise;return canvas.getContext('2d').getImageData(0,0,400,400).data;}finally{await task.destroy();}}

test('group schema retains same-page membership and rejects malformed, singleton and cross-page groups',()=>{
 const grouped=group(),copy=validateMarkups(grouped,2);
 assert.deepEqual(copy.map(m=>m.groupId),['group-one','group-one',undefined]);
 copy[0].points[0][0]=999;assert.equal(grouped[0].points[0][0],40);
 for(const groupId of ['',null,4,'group/bad','x'.repeat(121)])assert.throws(()=>validateMarkups([mark('a',{groupId}),mark('b',{groupId})],2));
 assert.throws(()=>validateMarkups([mark('a',{groupId:'g'})],2),/two/);
 assert.throws(()=>validateMarkups([mark('a',{groupId:'g'}),mark('b',{pageIndex:1,groupId:'g'})],2),/one page/);
});

test('group actions expand members, preserve distinct contents, move leaders and support atomic history',()=>{
 const original=source(),snapshot=structuredClone(original),grouped=groupMarkups(original,['a','b'],'group-one',2,later);
 const changed=updateMarkupSelection(grouped,['b'],{color:[0,0.6,0],width:3,opacity:0.4,status:'accepted'},2,later);
 assert.deepEqual(changed.map(m=>m.status),['accepted','accepted','open']);assert.deepEqual(changed.map(m=>m.contents),original.map(m=>m.contents));
 const moved=translateMarkupSelection(changed,['a'],10,20,2,later);
 assert.deepEqual(moved[0].points,[[50,70],[190,140]]);assert.deepEqual(moved[1].callout,[[110,120],[190,230]]);assert.deepEqual(moved[2],original[2]);
 const history=new WorkspaceHistory([{sourceId:'source',pageIndex:0,rotation:0},{sourceId:'source',pageIndex:1,rotation:0}],grouped);
 history.commit(history.pages,moved);history.undo();assert.deepEqual(history.markups,grouped);history.redo();assert.deepEqual(history.markups,moved);
 const ungrouped=ungroupMarkups(moved,['b'],2,later);assert.ok(ungrouped.every(m=>m.groupId===undefined));
 assert.deepEqual(deleteMarkupSelection(grouped,['a'],2),[original[2]]);
 assert.deepEqual(original,snapshot);
});

test('locked members reject partial group changes; only explicit group unlock bypasses the lock',()=>{
 const grouped=group(),locked=lockMarkupSelection(grouped,['a'],true,2,later),before=structuredClone(locked);
 assert.deepEqual(locked.map(m=>m.locked),[true,true,false]);
 for(const action of [()=>groupMarkups(locked,['a','b'],'g',2,later),()=>ungroupMarkups(locked,['a'],2,later),()=>updateMarkupSelection(locked,['a'],{width:4},2,later),()=>translateMarkupSelection(locked,['a'],1,1,2,later),()=>deleteMarkupSelection(locked,['a'],2),()=>lockMarkupSelection(locked,['a'],true,2,later)])assert.throws(action,/Unlock/);
 assert.deepEqual(locked,before);
 const unlocked=lockMarkupSelection(locked,['b'],false,2,later);assert.ok(unlocked.every(m=>!m.locked));
 assert.equal(deleteMarkupSelection(unlocked,['a'],2).length,1);
});

test('invalid selections, incompatible grouping and malformed patches fail without mutating inputs',()=>{
 const grouped=group(),before=structuredClone(grouped);
 for(const ids of [[],['missing'],['a','a'],new Array(1),[null]])assert.throws(()=>updateMarkupSelection(grouped,ids,{width:3},2,later));
 assert.throws(()=>groupMarkups(source(),['a'],'g',2,later),/two/);
 assert.throws(()=>groupMarkups(source(),['a','c'],'g',2,later),/one page/);
 assert.throws(()=>groupMarkups([...grouped,mark('d'),mark('e')],['d','e'],'group-one',2,later),/already belongs/);
 assert.throws(()=>ungroupMarkups(source(),['a'],2,later),/do not belong/);
 for(const patch of [{},{contents:'Override'}, {locked:false}, {color:new Array(3)}, {status:'unknown'}, {opacity:Infinity}, {width:undefined}])assert.throws(()=>updateMarkupSelection(grouped,['a'],patch,2,later));
 assert.throws(()=>translateMarkupSelection(grouped,['a'],NaN,0,2,later),/finite/);
 assert.throws(()=>translateMarkupSelection(grouped,['a'],1e8,0,2,later));
 assert.throws(()=>lockMarkupSelection(grouped,['a'],'false',2,later));
 assert.throws(()=>updateMarkupSelection(grouped,['a'],{width:3},2,'bad-time'));
 assert.deepEqual(grouped,before);
});

test('PDF groups link subordinate IRT directly to one primary and preserve source annotations and title',async()=>{
 const bytes=await base(),before=bytes.slice(),marks=group();
 const saved=await applyMarkups(bytes,marks),p=await PDFDocument.load(saved),a=p.getPage(0).node.Annots(),primary=p.context.lookup(a.get(0),PDFDict),sub=p.context.lookup(a.get(1),PDFDict);
 assert.equal(primary.has(PDFName.of('IRT')),false);assert.equal(primary.has(PDFName.of('RT')),false);
 assert.equal(sub.get(PDFName.of('IRT')).toString(),a.get(0).toString());assert.equal(sub.get(PDFName.of('RT')).toString(),'/Group');assert.equal(sub.lookup(PDFName.of('IRT')),primary);
 assert.equal(p.getPage(1).node.Annots().size(),1);assert.equal(p.getTitle(),'Original drawing');assert.deepEqual(bytes,before);
 const foreign=await applyMarkups(bytes,[mark('foreign')]);const appended=await PDFDocument.load(await applyMarkups(foreign,marks));
 assert.equal(appended.getPage(0).node.Annots().size(),3);const arr=appended.getPage(0).node.Annots(),subordinate=appended.context.lookup(arr.get(2),PDFDict);assert.equal(subordinate.get(PDFName.of('IRT')).toString(),arr.get(1).toString());
 const flat=await PDFDocument.load(await applyMarkups(foreign,marks,{flatten:true}));assert.equal(flat.getPage(0).node.Annots().size(),1);assert.equal(flat.getTitle(),'Original drawing');
});

test('group relationships do not change rendered appearance and flattened pixels match',async()=>{
 const bytes=await base(),marks=group(),grouped=await applyMarkups(bytes,marks),flat=await applyMarkups(bytes,marks,{flatten:true});
 const a=await pixels(grouped),b=await pixels(flat);let delta=0,nonwhite=0;for(let i=0;i<a.length;i++){delta+=Math.abs(a[i]-b[i]);if(i%4!==3&&a[i]<240)nonwhite++;}assert.ok(nonwhite>50);assert.ok(delta/a.length<0.2,`mean difference ${delta/a.length}`);
});
