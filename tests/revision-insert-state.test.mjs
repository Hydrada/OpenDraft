import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRevisionInsertion} from '../apps/opendraft/src/revision-insert.ts';
import {validateRevisionJournal} from '../apps/opendraft/src/revision-journal.ts';
import {WorkspaceHistory} from '../apps/opendraft/src/workspace-history.ts';
import {saveRecovery} from '../apps/opendraft/src/recovery.ts';
import {calibrateScale} from '../apps/opendraft/src/measurements.ts';

const mark = (id,pageIndex,kind='rectangle') => ({id,pageIndex,kind,points:[[0,0],[100,50]],...(kind==='stamp'?{stampName:'Expired'}:{}),color:[1,0,0],width:1,opacity:1,contents:'SUPERSEDED',author:'Reviewer',status:'open',locked:false,createdAt:'2026-10-21T12:00:00.000Z',modifiedAt:'2026-10-21T12:00:00.000Z'});
const entry = (extra={})=>({id:'entry',createdAt:'2026-10-21T12:00:00.000Z',reason:'Revision insertion',baseSha256:'a'.repeat(64),revisionSha256:'b'.repeat(64),replacements:[{targetPage:1,revisionPage:3}],markupPolicy:'retain',clearedMeasurements:1,clearedScales:1,...extra});
const state = ()=>({pages:Array.from({length:3},(_,i)=>({sourceId:'base',pageIndex:i,rotation:i===1?90:0})),markups:[mark('a',0),mark('b',1),mark('c',2)],takeoff:{scales:Array.from({length:3},(_,pageIndex)=>calibrateScale({id:`scale${pageIndex}`,pageIndex,points:[[0,0],[72,0]],distance:1,unit:'m'})),records:Array.from({length:3},(_,pageIndex)=>({id:`record${pageIndex}`,pageIndex,label:'quantity',kind:'length',points:[[0,0],[144,0]],unit:'m'}))}});
const pairs = [{basePage:3,revisionPage:1},{basePage:1,revisionPage:3}];
const stamps = ()=>[mark('superseded-c',2,'stamp'),mark('superseded-a',0,'stamp')];

test('insertion follows old-page order, retains originals and remaps old annotations plus supplied stamps',()=>{
  const current=state(), supplied=stamps(), before=structuredClone({current,supplied,pairs});
  const next=buildRevisionInsertion(current,pairs,'donor',['NEW-C',null,'NEW-A'],supplied);
  assert.deepEqual(next.pages,[{sourceId:'donor',pageIndex:2,rotation:0,inserted:true,label:'NEW-A'},current.pages[0],current.pages[1],{sourceId:'donor',pageIndex:0,rotation:0,inserted:true,label:'NEW-C'},current.pages[2]]);
  assert.deepEqual(next.markups.map(m=>[m.id,m.pageIndex]),[['a',1],['b',2],['c',4],['superseded-c',4],['superseded-a',1]]);
  assert.deepEqual(next.takeoff.scales.map(s=>[s.id,s.pageIndex]),[['scale1',2]]);
  assert.deepEqual(next.takeoff.records.map(r=>[r.id,r.pageIndex]),[['record1',2]]);
  assert.equal(next.takeoff.records[0].points[1][0],144);assert.equal(next.takeoff.scales[0].metersPerPdfUnit,current.takeoff.scales[1].metersPerPdfUnit);
  assert.deepEqual({current,supplied,pairs},before);
  next.markups[0].points[0][0]=999;next.takeoff.scales[0].reference.points[0][0]=999;next.pages[1].rotation=180;
  assert.deepEqual({current,supplied,pairs},before);
});

test('insertion supplies explicit fallback labels without copying old measurements to donor or old selected pages',()=>{
  const next=buildRevisionInsertion(state(),[{basePage:2,revisionPage:1}],'donor',['  '],[mark('stamp',1,'stamp')]);
  assert.equal(next.pages[1].label,'Revision page 1');assert.equal(next.pages[1].rotation,0);
  assert.deepEqual(next.takeoff.records.map(r=>r.pageIndex),[0,3]);
  assert.deepEqual(next.takeoff.scales.map(s=>s.pageIndex),[0,3]);
  assert.equal(next.pages[2].rotation,90);
});

test('journal preserves explicit operation, treats omitted operation as legacy, and rejects removal on insert-before',()=>{
  assert.equal('operation' in validateRevisionJournal([entry()])[0],false);
  for(const operation of ['replace','insert-before']) assert.equal(validateRevisionJournal([entry({operation})])[0].operation,operation);
  for(const operation of ['insert',null,1,{}]) assert.throws(()=>validateRevisionJournal([entry({operation})]));
  assert.throws(()=>validateRevisionJournal([entry({operation:'insert-before',markupPolicy:'remove'})]),/retain/);
});

test('insertion pages, measurement clearing and journal operation undo and redo atomically',()=>{
  const current=state(),next=buildRevisionInsertion(current,pairs,'donor',['NEW-C',null,'NEW-A'],stamps());
  const history=new WorkspaceHistory(current.pages,current.markups,current.takeoff);
  history.commit(next.pages,next.markups,next.takeoff,[],[entry({operation:'insert-before'})]);
  assert.equal(history.pages.length,5);assert.equal(history.pages[0].inserted,true);assert.equal(history.pages[0].label,'NEW-A');
  assert.equal(history.takeoff.records.length,1);assert.equal(history.revisions[0].operation,'insert-before');
  history.undo();assert.deepEqual(history.pages,current.pages);assert.deepEqual(history.takeoff,current.takeoff);assert.deepEqual(history.revisions,[]);
  history.redo();assert.deepEqual(history.pages,next.pages);assert.deepEqual(history.markups,next.markups);assert.deepEqual(history.takeoff,next.takeoff);
});

test('insertion rejects ambiguous pages, missing stamps, ID collisions and malformed state without mutation',()=>{
  const current=state(),before=structuredClone(current);
  const invoke=(p=pairs,s=stamps(),labels=['C',null,'A'],source='donor')=>buildRevisionInsertion(current,p,source,labels,s);
  for(const p of [[],null,new Array(1),[{basePage:0,revisionPage:1}],[{basePage:4,revisionPage:1}],[{basePage:1.5,revisionPage:1}],[{basePage:1,revisionPage:0}],[{basePage:1,revisionPage:4}],[{basePage:1,revisionPage:1},{basePage:1,revisionPage:2}],[{basePage:1,revisionPage:1},{basePage:2,revisionPage:1}],Array.from({length:101},()=>({basePage:1,revisionPage:1}))]) assert.throws(()=>invoke(p));
  for(const s of [[],[mark('s',1,'stamp')],[mark('s',0,'rectangle'),mark('t',2,'stamp')],[mark('a',0,'stamp'),mark('t',2,'stamp')],[mark('s',0,'stamp'),mark('t',0,'stamp')]]) assert.throws(()=>invoke(pairs,s));
  for(const labels of [[],null,new Array(3),[3,null,'A'],['x'.repeat(1001),null,'A']]) assert.throws(()=>invoke(pairs,stamps(),labels));
  for(const source of ['', ' ',null]) assert.throws(()=>invoke(pairs,stamps(),['C',null,'A'],source));
  assert.deepEqual(current,before);
});

test('recovery validates inserted fields and operation before reaching storage',async()=>{
  const next=buildRevisionInsertion(state(),pairs,'donor',['C',null,'A'],stamps());
  const snapshot=(pages=next.pages,revisions=[entry({operation:'insert-before'})])=>({version:1,documents:[{id:'d',name:'drawing.pdf',bytes:new Uint8Array([1]),page:1,zoom:1,rotations:[],workspace:{sources:[{id:'base',bytes:new Uint8Array([1])},{id:'donor',bytes:new Uint8Array([2])}],pages,markups:next.markups,takeoff:next.takeoff,revisions}}],activeId:'d'});
  // Node has no IndexedDB. This assertion proves model validation passed, not persistence.
  await assert.rejects(saveRecovery(snapshot()),/IndexedDB is unavailable/);
  for(const extra of [{inserted:false},{inserted:'yes'},{label:''},{label:' '},{label:'x'.repeat(1001)}]) await assert.rejects(saveRecovery(snapshot([{...next.pages[0],...extra},...next.pages.slice(1)])),/insert|label/i);
  await assert.rejects(saveRecovery(snapshot([{...next.pages[0],sourceId:'absent'},...next.pages.slice(1)])),/recovery page/);
  await assert.rejects(saveRecovery(snapshot(next.pages,[entry({operation:'insert-before',markupPolicy:'remove'})])),/retain/);
});
