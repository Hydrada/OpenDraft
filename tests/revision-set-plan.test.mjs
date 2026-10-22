import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRevisionSetPlan,parseRevisionSetPlan,serializeRevisionSetPlan,resolveRevisionSetPlan,REVISION_SET_PLAN_MAX_BYTES} from '../apps/opendraft/src/revision-set-plan.ts';

const time='2026-10-21T12:00:00.000Z';
const job=(a='a',b='b')=>({schema:'opendraft.revision-plan',version:1,createdAt:time,base:{sha256:a.repeat(64),pageCount:3},revision:{sha256:b.repeat(64),pageCount:4},operation:'insert-before',markupPolicy:'retain',reason:'Issued revision – 図面',pairs:[{basePage:3,revisionPage:1},{basePage:1,revisionPage:4}]});
const plan=()=>({schema:'opendraft.revision-set-plan',version:1,createdAt:time,jobs:[job(),job('c','d')]});

test('set plans roundtrip detached known fields without approvals, bytes, names or result baggage',()=>{
  const input=plan();input.approved=true;input.results=[{status:'succeeded'}];input.jobs[0].base.bytes=[1,2];input.jobs[0].revision.name='secret.pdf';
  const before=structuredClone(input), canonical=validateRevisionSetPlan(input),text=serializeRevisionSetPlan(input);
  assert.deepEqual(parseRevisionSetPlan(text),plan());assert.deepEqual(input,before);
  for(const key of ['approved','results','bytes','secret'])assert.equal(text.includes(key),false);
  canonical.jobs[0].pairs[0].basePage=2;assert.equal(input.jobs[0].pairs[0].basePage,3);
});

test('all sources resolve by exact identity independent of order and without mutating input',()=>{
  const input=plan(),before=structuredClone(input);
  const result=resolveRevisionSetPlan(input,[input.jobs[1].base,input.jobs[0].base],[input.jobs[0].revision,input.jobs[1].revision]);
  assert.deepEqual(result.matches.map(({baseIndex,revisionIndex})=>({baseIndex,revisionIndex})),[{baseIndex:1,revisionIndex:0},{baseIndex:0,revisionIndex:1}]);
  result.matches[0].pairs[0].basePage=2;assert.deepEqual(input,before);
  for(const bases of [[],[input.jobs[0].base],[input.jobs[0].base,input.jobs[1].base,input.jobs[1].base],[input.jobs[0].base,{...input.jobs[1].base,pageCount:2}]])assert.throws(()=>resolveRevisionSetPlan(input,bases,input.jobs.map(j=>j.revision)),/exactly one/);
  assert.throws(()=>resolveRevisionSetPlan(input,input.jobs.map(j=>j.base),[{...input.jobs[0].revision,sha256:'e'.repeat(64)},input.jobs[1].revision]),/exactly one/);
});

test('invalid sets reject unsupported schemas, inherited fields, sparse arrays, duplicates and mixed settings',()=>{
  for(const value of [null,[],{},Object.create(plan()),{...plan(),version:2},{...plan(),schema:'opendraft.revision-set'},{...plan(),createdAt:'2026-10-21'},{...plan(),jobs:[]},{...plan(),jobs:new Array(2)}])assert.throws(()=>validateRevisionSetPlan(value));
  for(const key of Object.keys(plan())){const input=plan();delete input[key];assert.throws(()=>validateRevisionSetPlan(input));}
  for(const side of ['base','revision']){const input=plan();input.jobs[1][side]=input.jobs[0][side];assert.throws(()=>validateRevisionSetPlan(input),/unique/);}
  for(const settings of [{operation:'replace'},{reason:'different'},{operation:'replace',markupPolicy:'remove'}]){const input=plan();Object.assign(input.jobs[1],settings);assert.throws(()=>validateRevisionSetPlan(input));}
  const input=plan();input.jobs[1].pairs=[{basePage:201,revisionPage:1}];assert.throws(()=>validateRevisionSetPlan(input));
});

test('20 jobs of 100 pairs serialize and UTF-8 limits apply at the exact byte boundary',()=>{
  const input=plan();input.jobs=Array.from({length:20},(_,i)=>({...job(),base:{sha256:i.toString(16).padStart(64,'0'),pageCount:200},revision:{sha256:(i+20).toString(16).padStart(64,'0'),pageCount:200},reason:'界'.repeat(1000),pairs:Array.from({length:100},(_,p)=>({basePage:p+1,revisionPage:200-p}))}));
  assert.deepEqual(parseRevisionSetPlan(serializeRevisionSetPlan(input)),input);
  input.jobs.push(job());assert.throws(()=>validateRevisionSetPlan(input),/1–20/);
  const text=serializeRevisionSetPlan(plan()),padding=REVISION_SET_PLAN_MAX_BYTES-new TextEncoder().encode(text).length;
  assert.deepEqual(parseRevisionSetPlan(text+' '.repeat(padding)),plan());
  assert.throws(()=>parseRevisionSetPlan(text+' '.repeat(padding+1)),/1 MiB/);
  assert.throws(()=>parseRevisionSetPlan('界'.repeat(400000)),/1 MiB/);
  for(const text of ['{','not json'])assert.throws(()=>parseRevisionSetPlan(text),/not valid JSON/);
  const polluted=JSON.stringify(plan()).replace('"version":1','"version":1,"__proto__":{"approved":true}');
  assert.deepEqual(parseRevisionSetPlan(polluted),plan());assert.equal({}.approved,undefined);
});
