import test from 'node:test';
import assert from 'node:assert/strict';
import { takeoffCsv, takeoffXlsx } from '../apps/opendraft/src/takeoff-reports.ts';
import { unzipSync, strFromU8 } from 'fflate';
import { calibrateScale } from '../apps/opendraft/src/measurements.ts';

const scale = calibrateScale({id:'page-scale',pageIndex:0,points:[[0,0],[72,0]],distance:10,unit:'ft'});
const record = {id:'run',label:'Main,"run"\nnext',pageIndex:0,kind:'length',points:[[0,0],[144,0]],unit:'ft'};
test('takeoff CSV retains unrounded quantities, source geometry and calibration evidence without mutation', () => {
  const input = {scales:[scale],records:[record]};
  const before = JSON.stringify(input);
  const csv = takeoffCsv('drawing.pdf',1,input);
  assert.ok(csv.includes('"20","ft"'));
  assert.ok(csv.includes('"Main,""run""\nnext"'));
  assert.ok(csv.includes('"[[0,0],[144,0]]"'));
  assert.ok(csv.includes(`"${scale.metersPerPdfUnit}","[[0,0],[72,0]]","10","ft"`));
  assert.equal(JSON.stringify(input),before);
});
test('takeoff CSV guards text formulas and rejects stale or invalid evidence', () => {
  const input = {scales:[scale],records:[{...record,id:'@id',label:'\t=SUM(1,2)'}]};
  const csv = takeoffCsv('+document.pdf',1,input);
  assert.ok(csv.includes('"\'+document.pdf"'));
  assert.ok(csv.includes('"\'@id"'));
  assert.ok(csv.includes('"\'\t=SUM(1,2)"'));
  assert.throws(()=>takeoffCsv('a',1,{...input,scales:[{...scale,metersPerPdfUnit:9}]}));
  assert.throws(()=>takeoffCsv('',1,input));
  assert.throws(()=>takeoffCsv('a',0,input));
  assert.equal(takeoffCsv('a',1,{scales:[],records:[]}).split('\r\n').length,2);
});

test('XLSX uses literal string cells for formulas and numeric quantities with no external content', async () => {
  const input = {scales:[scale],records:[{...record,label:'=HYPERLINK("https://invalid.test")'}]};
  const before = JSON.stringify(input);
  const files = unzipSync(await takeoffXlsx('@document',1,input));
  const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
  const all = Object.values(files).map(strFromU8).join('\n');
  assert.ok(!xml.includes('<f>'));
  assert.match(xml, /<c[^>]*r="F2"[^>]*>[\s\S]*?<v>20<\/v>/);
  assert.ok(all.includes('HYPERLINK'));
  assert.ok(!Object.keys(files).some(name=>/externalLinks|vbaProject/i.test(name)));
  assert.equal(JSON.stringify(input),before);
});

test('XLSX fails explicitly when cell evidence exceeds Excel limits or XML controls occur', async () => {
  await assert.rejects(takeoffXlsx('bad\u0000name',1,{scales:[scale],records:[record]}));
  const count = {...record,kind:'count',points:Array.from({length:4000},(_,i)=>[i+0.1234567,0])};
  await assert.rejects(takeoffXlsx('a',1,{scales:[],records:[count]}),/Excel limits/);
});
