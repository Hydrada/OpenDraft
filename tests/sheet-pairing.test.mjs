import test from 'node:test';
import assert from 'node:assert/strict';
import {pairSheets, validateSheetPairs, SHEET_PAIRING_LIMITS} from '../apps/opendraft/src/sheet-pairing.ts';

const pair = (extra = {}) => ({id:'one',basePage:1,revisionPage:1,reason:'manual',scale:1,rotationDegrees:0,offsetX:0,offsetY:0,...extra});

test('unique normalized labels correlate reordered sheets and preserve explicit unmatched pages', () => {
  const base = [' A101 ', 'b\t202', 'caf\u00e9', 'D404'];
  const revision = ['CAF' + 'E\u0301', ' B   202 ', 'a101', 'E505'];
  const before = structuredClone({base, revision});
  const result = pairSheets(base, revision, 'label');
  assert.deepEqual(result.pairs.map(p => [p.basePage,p.revisionPage,p.reason]), [[1,3,'label'],[2,2,'label'],[3,1,'label']]);
  assert.deepEqual(result.unmatchedBase, [4]); assert.deepEqual(result.unmatchedRevision, [4]);
  assert.deepEqual(result.warnings, []); assert.deepEqual({base,revision}, before);
  assert.deepEqual(result, pairSheets(base,revision,'label'));
  assert.deepEqual(result.pairs[0], pair({id:'sheet-1-3',revisionPage:3,reason:'label'}));
});

test('duplicates on either side never produce an arbitrary match, including Unicode uppercase collisions', () => {
  const result = pairSheets(['A','a','B','Straße','C'], ['A','B','b','STRASSE','strasse','C'], 'label');
  assert.deepEqual(result.pairs.map(p => [p.basePage,p.revisionPage]), [[5,6]]);
  assert.deepEqual(result.unmatchedBase,[1,2,3,4]); assert.deepEqual(result.unmatchedRevision,[1,2,3,4,5]);
  assert.equal(result.warnings.length,3);
  assert.match(result.warnings[0],/Base pages 1, 2.*duplicate/);
  assert.match(result.warnings[1],/Revision pages 2, 3.*duplicate/);
  assert.match(result.warnings[2],/Revision pages 4, 5.*duplicate/);
});

test('missing labels remain unmatched without silently substituting page numbers', () => {
  const result = pairSheets([null,'',' \n ','1'], ['1',null,'',' '], 'label');
  assert.deepEqual(result.pairs.map(p => [p.basePage,p.revisionPage]), [[4,1]]);
  assert.deepEqual(result.unmatchedBase,[1,2,3]); assert.deepEqual(result.unmatchedRevision,[2,3,4]);
  assert.equal(result.warnings.length,6);
});

test('explicit order matches page indices even when labels differ or are missing', () => {
  const result = pairSheets(['A','A',null], ['Z',null], 'order');
  assert.deepEqual(result.pairs.map(p => [p.basePage,p.revisionPage,p.reason]), [[1,1,'order'],[2,2,'order']]);
  assert.deepEqual(result.unmatchedBase,[3]); assert.deepEqual(result.unmatchedRevision,[]); assert.deepEqual(result.warnings,[]);
});

test('pairing rejects invalid metadata and page budgets before generating a plan', () => {
  for (const bad of [[],new Array(201).fill(null),[undefined],[2],new Array(2),'A',null]) {
    assert.throws(() => pairSheets(bad,['A'],'label'));
    assert.throws(() => pairSheets(['A'],bad,'order'));
  }
  assert.throws(() => pairSheets(['A'],['A'],'guess'));
  const result = pairSheets(new Array(200).fill(null),new Array(200).fill(null),'order');
  assert.equal(result.pairs.length,200); // review plan may contain more rows than one selected run permits
  assert.throws(() => validateSheetPairs(result.pairs,200,200),/100/);
  assert.equal(SHEET_PAIRING_LIMITS.maxPages,200);
});

test('selected plan validates exact boundaries and creates detached canonical objects', () => {
  const input = [pair({scale:0.1,rotationDegrees:-3600,offsetX:-100000,offsetY:100000,extra:'discard'}),pair({id:'two',basePage:200,revisionPage:200,reason:'label',scale:10,rotationDegrees:3600})];
  const result = validateSheetPairs(input,200,200);
  assert.notEqual(result,input); assert.notEqual(result[0],input[0]); assert.equal('extra' in result[0],false);
  input[0].scale=4; assert.equal(result[0].scale,0.1);
  const hundred=Array.from({length:100},(_,i)=>pair({id:String(i),basePage:i+1,revisionPage:100-i,reason:'order'}));
  assert.equal(validateSheetPairs(hundred,100,100).length,100);
});

test('selected plan rejects forged pages, duplicates, identifiers, reasons and nonfinite transforms', () => {
  for (const field of ['basePage','revisionPage']) for (const value of [0,-1,1.5,3,NaN,Infinity,'1',null]) {
    assert.throws(() => validateSheetPairs([pair({[field]:value})],2,2));
  }
  for (const id of ['', ' \n ',1,null,undefined]) assert.throws(() => validateSheetPairs([pair({id})],2,2));
  for (const reason of ['guess',null,undefined,1]) assert.throws(() => validateSheetPairs([pair({reason})],2,2));
  for (const scale of [0,0.09999,10.00001,NaN,Infinity,'1',null]) assert.throws(() => validateSheetPairs([pair({scale})],2,2));
  for (const field of ['offsetX','offsetY','rotationDegrees']) {
    const max = field==='rotationDegrees' ? 3600 : 100000;
    for (const value of [max+0.01,-max-0.01,NaN,Infinity,-Infinity,'0',null,undefined]) assert.throws(() => validateSheetPairs([pair({[field]:value})],2,2));
  }
  for (const second of [pair({basePage:2,revisionPage:2}),pair({id:'two',revisionPage:2}),pair({id:'two',basePage:2})]) {
    assert.throws(() => validateSheetPairs([pair(),second],2,2));
  }
  for (const invalid of [[],null,{},[null],[[]],new Array(1)]) assert.throws(() => validateSheetPairs(invalid,2,2));
  for (const count of [0,-1,201,NaN,Infinity,1.5,'2']) {
    assert.throws(() => validateSheetPairs([pair()],count,2)); assert.throws(() => validateSheetPairs([pair()],2,count));
  }
});
