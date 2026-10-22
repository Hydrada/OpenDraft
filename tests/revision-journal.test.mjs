import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRevisionJournal} from '../apps/opendraft/src/revision-journal.ts';
import {WorkspaceHistory} from '../apps/opendraft/src/workspace-history.ts';
import {saveRecovery} from '../apps/opendraft/src/recovery.ts';

const entry = (overrides={}) => ({id:'revision-1',createdAt:'2026-10-21T15:20:30.000Z',reason:'Issued drawing replacement',baseSha256:'a'.repeat(64),revisionSha256:'b'.repeat(64),replacements:[{targetPage:2,revisionPage:3}],markupPolicy:'retain',clearedMeasurements:2,clearedScales:1,...overrides});
const pages = [{sourceId:'base',pageIndex:0,rotation:0},{sourceId:'base',pageIndex:1,rotation:0}];
const snapshot = (workspace={}) => ({version:1,documents:[{id:'drawing',name:'drawing.pdf',bytes:new Uint8Array([1]),page:1,zoom:1,rotations:[],workspace:{sources:[{id:'base',bytes:new Uint8Array([1])},{id:'revision',bytes:new Uint8Array([2])}],pages,markups:[],...workspace}}],activeId:'drawing'});

test('revision journal makes canonical detached copies including replacement page snapshots', () => {
  const input=[entry({extra:'discard',replacements:[{targetPage:2,revisionPage:3,extra:'discard'}]})];
  const result=validateRevisionJournal(input);
  assert.deepEqual(result,[entry()]);
  input[0].replacements[0].targetPage=99; input[0].reason='changed';
  assert.equal(result[0].replacements[0].targetPage,2); assert.equal(result[0].reason,'Issued drawing replacement');
  assert.deepEqual(validateRevisionJournal([]),[]);
  assert.equal(validateRevisionJournal(Array.from({length:1000},(_,i)=>entry({id:String(i)}))).length,1000);
});

test('revision journal rejects forged shapes, identity, hashes, timestamps and counts', () => {
  for(const value of [null,{},'journal',[null],[[]],new Array(1),Array.from({length:1001},(_,i)=>entry({id:String(i)}))]) assert.throws(()=>validateRevisionJournal(value));
  for(const id of ['', ' \n ', 'x'.repeat(201),null,3]) assert.throws(()=>validateRevisionJournal([entry({id})]));
  assert.throws(()=>validateRevisionJournal([entry(),entry()]));
  for(const reason of ['', '\t', 'r'.repeat(1001),null,3]) assert.throws(()=>validateRevisionJournal([entry({reason})]));
  for(const field of ['baseSha256','revisionSha256']) for(const hash of ['a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'z'.repeat(64),null,5]) assert.throws(()=>validateRevisionJournal([entry({[field]:hash})]));
  for(const createdAt of ['2026-10-21','2026-10-21T15:20:30Z','2026-02-30T15:20:30.000Z','2026-10-21T15:20:30.000+00:00','invalid',null,42]) assert.throws(()=>validateRevisionJournal([entry({createdAt})]));
  for(const field of ['clearedMeasurements','clearedScales']) for(const count of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0',null]) assert.throws(()=>validateRevisionJournal([entry({[field]:count})]));
  for(const markupPolicy of ['preserve',null,1]) assert.throws(()=>validateRevisionJournal([entry({markupPolicy})]));
});

test('revision replacement snapshots require bounded one-to-one positive page numbers', () => {
  for(const replacements of [[],null,{},[null],[[]],new Array(1),Array.from({length:101},(_,i)=>({targetPage:i+1,revisionPage:i+1}))]) assert.throws(()=>validateRevisionJournal([entry({replacements})]));
  for(const field of ['targetPage','revisionPage']) for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1',null]) assert.throws(()=>validateRevisionJournal([entry({replacements:[{targetPage:1,revisionPage:1,[field]:value}]})]));
  assert.throws(()=>validateRevisionJournal([entry({replacements:[{targetPage:1,revisionPage:1},{targetPage:1,revisionPage:2}]})]));
  assert.throws(()=>validateRevisionJournal([entry({replacements:[{targetPage:1,revisionPage:1},{targetPage:2,revisionPage:1}]})]));
  assert.equal(validateRevisionJournal([entry({replacements:Array.from({length:100},(_,i)=>({targetPage:i+1,revisionPage:100-i}))})])[0].replacements.length,100);
});

test('revision journal joins atomic history undo/redo while omitted fifth arguments preserve it', () => {
  const initial=entry(); const history=new WorkspaceHistory(pages,[],undefined,[],[initial]);
  initial.replacements[0].targetPage=99; assert.equal(history.revisions[0].replacements[0].targetPage,2);
  const next=entry({id:'revision-2',markupPolicy:'remove'});
  const rotated=[{...pages[0],rotation:90},pages[1]];
  history.commit(rotated,[],undefined,[],[...history.revisions,next]);
  const copy=history.revisions;copy[1].reason='changed';copy[0].replacements[0].revisionPage=90;
  assert.equal(history.revisions[1].reason,'Issued drawing replacement');assert.equal(history.revisions[0].replacements[0].revisionPage,3);
  history.undo();assert.equal(history.pages[0].rotation,0);assert.equal(history.revisions.length,1);
  history.redo();assert.equal(history.pages[0].rotation,90);assert.equal(history.revisions.length,2);
  history.commit([{...pages[0],rotation:180},pages[1]]);assert.equal(history.revisions.length,2);
  const before=history.revisions;
  assert.throws(()=>history.commit(pages,[],undefined,[],[entry({baseSha256:'invalid'})]));
  assert.deepEqual(history.revisions,before);assert.equal(history.pages[0].rotation,180);
  history.undo();history.undo();history.commit(pages,[],undefined,[],[entry({id:'branched'})]);
  assert.equal(history.canRedo,false);assert.deepEqual(history.revisions.map(e=>e.id),['branched']);
});

test('legacy history callers have an empty journal and a journal-only commit remains reversible', () => {
  const history=new WorkspaceHistory(pages); assert.deepEqual(history.revisions,[]);
  history.commit(pages,undefined,undefined,undefined,[entry()]);assert.equal(history.canUndo,true);
  history.undo();assert.deepEqual(history.revisions,[]);history.redo();assert.equal(history.revisions.length,1);
});

test('recovery rejects forged journals and unresolved replacement references before storage', async () => {
  await assert.rejects(saveRecovery(snapshot({revisions:[entry({revisionSha256:'invalid'})]})),/source hashes/);
  for(const replacement of [null,{sourceId:'absent',pageIndex:0},{sourceId:'revision',pageIndex:-1},{sourceId:'revision',pageIndex:0.5},{sourceId:'revision',pageIndex:Infinity}]) {
    await assert.rejects(saveRecovery(snapshot({pages:[{...pages[0],replacement}]})),/replacement page/);
  }
  // In Node there is no IndexedDB: reaching this error proves optional legacy fields and valid refs passed model validation.
  await assert.rejects(saveRecovery(snapshot()),/IndexedDB is unavailable/);
  await assert.rejects(saveRecovery(snapshot({revisions:[entry()],pages:[{...pages[0],replacement:{sourceId:'revision',pageIndex:0}}]})),/IndexedDB is unavailable/);
});
