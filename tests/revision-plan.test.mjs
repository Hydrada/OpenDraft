import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRevisionPlan,parseRevisionPlan,serializeRevisionPlan,assertRevisionPlanSources,REVISION_PLAN_MAX_BYTES} from '../apps/opendraft/src/revision-plan.ts';

const plan=(extra={})=>({schema:'opendraft.revision-plan',version:1,createdAt:'2026-10-21T12:00:00.000Z',base:{sha256:'a'.repeat(64),pageCount:3},revision:{sha256:'b'.repeat(64),pageCount:4},operation:'replace',markupPolicy:'retain',reason:'Issued revision – prüfung 図面',pairs:[{basePage:1,revisionPage:4},{basePage:3,revisionPage:2}],...extra});

test('saved plans roundtrip Unicode with deterministic known fields and detached objects',()=>{
  const value=plan({approved:true,bytes:[1,2],filename:'private.pdf',path:'C:/private'});
  value.base.bytes=[4];value.pairs[0].approved=true;
  const before=structuredClone(value), canonical=validateRevisionPlan(value);
  assert.deepEqual(canonical,plan());assert.deepEqual(value,before);
  const text=serializeRevisionPlan(value);assert.equal(text,serializeRevisionPlan(canonical));assert.deepEqual(parseRevisionPlan(text),plan());
  assert.equal(text.includes('private'),false);assert.equal(text.includes('approved'),false);assert.equal(text.includes('bytes'),false);
  canonical.pairs[0].basePage=2;canonical.base.sha256='c'.repeat(64);
  assert.equal(value.pairs[0].basePage,1);assert.equal(value.base.sha256,'a'.repeat(64));
});

test('exact hash and page count binding rejects replaced, edited, reversed or stale sources',()=>{
  const value=plan();assert.doesNotThrow(()=>assertRevisionPlanSources(value,value.base,value.revision));
  const before=structuredClone(value);
  for(const base of [{...value.base,sha256:'c'.repeat(64)},{...value.base,pageCount:2}]) assert.throws(()=>assertRevisionPlanSources(value,base,value.revision),/do not match/);
  for(const revision of [{...value.revision,sha256:'c'.repeat(64)},{...value.revision,pageCount:3}]) assert.throws(()=>assertRevisionPlanSources(value,value.base,revision),/do not match/);
  assert.throws(()=>assertRevisionPlanSources(value,value.revision,value.base),/do not match/);
  assert.throws(()=>assertRevisionPlanSources(value,{...value.base,sha256:'invalid'},value.revision),/hash/);
  assert.deepEqual(value,before);
});

test('schema, required fields, canonical timestamps and operation policy reject malformed values',()=>{
  for(const value of [null,[],{},'text',1]) assert.throws(()=>validateRevisionPlan(value));
  for(const key of Object.keys(plan())) {const value=plan();delete value[key];assert.throws(()=>validateRevisionPlan(value));}
  for(const schema of ['other',null,1]) assert.throws(()=>validateRevisionPlan(plan({schema})));
  for(const version of [0,2,'1',null]) assert.throws(()=>validateRevisionPlan(plan({version})));
  for(const createdAt of ['2026-10-21','2026-10-21T12:00:00Z','2026-02-30T12:00:00.000Z','2026-10-21T12:00:00.000+00:00',null,1]) assert.throws(()=>validateRevisionPlan(plan({createdAt})));
  for(const reason of ['', ' \t ', 'x'.repeat(1001),null,1]) assert.throws(()=>validateRevisionPlan(plan({reason})));
  for(const operation of ['insert',null,1]) assert.throws(()=>validateRevisionPlan(plan({operation})));
  for(const markupPolicy of ['preserve',null,1]) assert.throws(()=>validateRevisionPlan(plan({markupPolicy})));
  assert.throws(()=>validateRevisionPlan(plan({operation:'insert-before',markupPolicy:'remove'})),/retain/);
  assert.equal(validateRevisionPlan(plan({operation:'insert-before'})).operation,'insert-before');
  assert.equal(validateRevisionPlan(plan({markupPolicy:'remove'})).markupPolicy,'remove');
});

test('source bounds and positive unique one-to-one pair bounds are enforced',()=>{
  for(const side of ['base','revision']) {
    for(const pageCount of [0,201,1.5,Infinity,NaN,'3',null]) assert.throws(()=>validateRevisionPlan(plan({[side]:{sha256:'a'.repeat(64),pageCount}})));
    for(const sha256 of ['A'.repeat(64),'g'.repeat(64),'a'.repeat(63),'a'.repeat(65),null,5]) assert.throws(()=>validateRevisionPlan(plan({[side]:{sha256,pageCount:3}})));
    for(const value of [null,[],{},Object.create({sha256:'a'.repeat(64),pageCount:3})]) assert.throws(()=>validateRevisionPlan(plan({[side]:value})));
  }
  for(const pairs of [[],null,{},new Array(1),[null],[[]],Array.from({length:101},()=>({basePage:1,revisionPage:1}))]) assert.throws(()=>validateRevisionPlan(plan({pairs})));
  for(const field of ['basePage','revisionPage']) for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER,'1',null]) assert.throws(()=>validateRevisionPlan(plan({pairs:[{basePage:1,revisionPage:1,[field]:value}]})));
  assert.throws(()=>validateRevisionPlan(plan({pairs:[{basePage:4,revisionPage:1}]})));
  assert.throws(()=>validateRevisionPlan(plan({pairs:[{basePage:1,revisionPage:5}]})));
  assert.throws(()=>validateRevisionPlan(plan({pairs:[{basePage:1,revisionPage:1},{basePage:1,revisionPage:2}]})));
  assert.throws(()=>validateRevisionPlan(plan({pairs:[{basePage:1,revisionPage:1},{basePage:2,revisionPage:1}]})));
  const boundary=plan({base:{sha256:'a'.repeat(64),pageCount:200},revision:{sha256:'b'.repeat(64),pageCount:200},reason:'x'.repeat(1000),pairs:Array.from({length:100},(_,i)=>({basePage:i+1,revisionPage:200-i}))});
  assert.deepEqual(validateRevisionPlan(boundary),boundary);
});

test('UTF-8 budget is checked before parsing, including multibyte input and exact limit',()=>{
  assert.equal(REVISION_PLAN_MAX_BYTES,262144);
  const encoded=serializeRevisionPlan(plan()), remaining=REVISION_PLAN_MAX_BYTES-new TextEncoder().encode(encoded).length;
  assert.deepEqual(parseRevisionPlan(encoded+' '.repeat(remaining)),plan());
  assert.throws(()=>parseRevisionPlan(encoded+' '.repeat(remaining+1)),/256 KiB/);
  assert.throws(()=>parseRevisionPlan('界'.repeat(90000)),/256 KiB/); // code units below the cap, UTF-8 bytes above it
  for(const text of ['{','not JSON','\uFEFF{}']) assert.throws(()=>parseRevisionPlan(text),/not valid JSON/);
  for(const text of [null,{},1]) assert.throws(()=>parseRevisionPlan(text),/256 KiB/);
  for(const text of ['null','[]','{}']) assert.throws(()=>parseRevisionPlan(text));
});

test('prototype baggage cannot supply required fields or persist approval/prototype pollution',()=>{
  const inherited=Object.create(plan());assert.throws(()=>validateRevisionPlan(inherited));
  const value=plan();value.pairs=[Object.create({basePage:1,revisionPage:1})];assert.throws(()=>validateRevisionPlan(value));
  const json=JSON.stringify(plan()).replace('"version":1','"version":1,"__proto__":{"approved":true},"approved":true');
  const canonical=parseRevisionPlan(json);
  assert.deepEqual(canonical,plan());assert.equal(Object.hasOwn(canonical,'__proto__'),false);assert.equal(canonical.approved,undefined);assert.equal({}.approved,undefined);
  const withPrototype=Object.assign(Object.create({approved:true}),plan());
  assert.deepEqual(validateRevisionPlan(withPrototype),plan());
});
