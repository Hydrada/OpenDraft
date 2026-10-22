import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePresetLibrary, parsePresetLibrary, serializePresetLibrary, presetFromMarkup } from '../apps/opendraft/src/markup-presets.ts';

const preset = (overrides={}) => ({id:'review',name:'Review',kind:'rectangle',color:[0.8,0.1,0.2],width:2,opacity:0.7,contents:'Check dimension',...overrides});
const library = (...presets) => ({version:1,presets});

test('all ten preset tools round-trip without document geometry, authorship or workflow state', () => {
  const kinds=['rectangle','ellipse','line','arrow','highlight','ink','text','cloud','callout','stamp'];
  const original=kinds.map(kind=>preset({id:kind,name:kind,kind,...(kind==='stamp'?{stampName:'ForComment'}:{}),points:[[999,999]],callout:[[4,5]],author:'Other reviewer',locked:true,status:'accepted',pageIndex:12}));
  const encoded=serializePresetLibrary(original);
  const parsed=parsePresetLibrary(encoded);
  assert.equal(parsed.length,10);
  assert.deepEqual(Object.keys(parsed[8]).sort(),['id','name','kind','color','width','opacity','contents'].sort());
  assert.equal(parsed[8].kind,'callout');
  assert.equal(encoded.includes('Other reviewer'),false);
  parsed[0].color[0]=0;
  assert.equal(original[0].color[0],0.8);
});

test('preset creation canonicalizes names and copies style without changing source markup', () => {
  const mark={...preset(),id:'drawing-id',author:'Private name',pageIndex:4,points:[[1,2],[3,4]],status:'rejected',locked:true};
  const result=presetFromMarkup(mark,'  Cafe\u0301 review  ','tool-1');
  assert.equal(result.name,'Café review');
  assert.equal(result.id,'tool-1');
  result.color[0]=0;
  assert.equal(mark.color[0],0.8);
  assert.equal(mark.id,'drawing-id');
  assert.equal(result.author,undefined);
  assert.deepEqual(validatePresetLibrary(library()),[]);
});

test('malformed imports and conflicting names/ids fail instead of overwriting tools', () => {
  for(const value of [null,[],{},library(null),{version:'1',presets:[]},{version:2,presets:[]},{version:1,presets:{}},library(preset({id:'bad/id'})),library(preset({name:'  '})),library(preset({name:'a'.repeat(81)})),library(preset({name:'bad\nname'})),library(preset({kind:'script'})),library(preset({width:0})),library(preset({opacity:2})),library(preset({color:[1,0]})),library(preset({color:[NaN,0,0]})),library(preset({color:new Array(3)})),library(preset({contents:'unsupported \u4e00'})),library(preset({contents:42}))]) {
    assert.throws(()=>validatePresetLibrary(value));
  }
  assert.throws(()=>validatePresetLibrary(library(preset(),preset({name:'Different'}))),/Duplicate/);
  assert.throws(()=>validatePresetLibrary(library(preset(),preset({id:'second',name:' review '}))),/Duplicate/);
  assert.throws(()=>validatePresetLibrary(library(preset({name:'Café'}),preset({id:'second',name:'CAFE\u0301'}))),/Duplicate/);
  assert.throws(()=>parsePresetLibrary('{'),/valid JSON/);
  assert.throws(()=>validatePresetLibrary({version:1,presets:new Array(1)}),/Invalid/);
});

test('library count and UTF-8 byte limits apply to import, validation and export', () => {
  const atLimit=Array.from({length:200},(_,index)=>preset({id:`p${index}`,name:`Preset ${index}`}));
  assert.equal(parsePresetLibrary(serializePresetLibrary(atLimit)).length,200);
  assert.throws(()=>serializePresetLibrary([...atLimit,preset({id:'extra',name:'Extra'})]),/200/);
  assert.throws(()=>parsePresetLibrary(' '.repeat(1024*1024+1)),/1 MiB/);
  assert.throws(()=>validatePresetLibrary({...library(),extra:'é'.repeat(600000)}),/1 MiB/);
  const excessive=atLimit.map(item=>({...item,contents:'x'.repeat(10000)}));
  assert.throws(()=>serializePresetLibrary(excessive),/1 MiB/);
  const circular=library(); circular.self=circular;
  assert.throws(()=>validatePresetLibrary(circular),/serializable/);
});


test('stamp presets retain standard appearance without accepting forged types',()=>{
  const original=preset({kind:'stamp',stampName:'Confidential',contents:''});
  assert.equal(parsePresetLibrary(serializePresetLibrary([original]))[0].stampName,'Confidential');
  assert.throws(()=>serializePresetLibrary([preset({kind:'stamp'})]));
  assert.throws(()=>serializePresetLibrary([preset({kind:'stamp',stampName:'RunScript'})]));
  assert.throws(()=>serializePresetLibrary([preset({stampName:'Draft'})]));
});
