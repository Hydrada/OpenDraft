import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateScale, measure } from '../apps/opendraft/src/measurements.ts';
import { validateTakeoff, emptyTakeoff } from '../apps/opendraft/src/takeoff.ts';

const scale = () => calibrateScale({id:'page-1',pageIndex:0,points:[[0,0],[100,0]],distance:10,unit:'ft'});
const record = () => ({id:'pipe-1',label:'Pipe centerline',pageIndex:0,kind:'length',points:[[0,0],[100,0]],unit:'ft'});

test('takeoff round trip preserves calibration evidence and geometry with no cached quantities', () => {
  const input={scales:[scale()],records:[{...record(),result:{value:999999}}]};
  const output=validateTakeoff(JSON.parse(JSON.stringify(input)),1);
  assert.equal('result' in output.records[0],false);
  assert.ok(Math.abs(measure({...output.records[0],scales:output.scales}).value-10)<1e-12);
  assert.deepEqual(output.scales[0].reference,{points:[[0,0],[100,0]],distance:10,unit:'ft'});
  assert.deepEqual(validateTakeoff(emptyTakeoff(),0),{scales:[],records:[]});
});

test('canonical takeoff makes defensive clones and quantities derive from current reviewed evidence', () => {
  const input={scales:[scale()],records:[record()]};
  const output=validateTakeoff(input,1);
  input.scales[0].reference.points[0][0]=99;
  input.records[0].points[1][0]=50;
  assert.deepEqual(output.scales[0].reference.points[0],[0,0]);
  assert.deepEqual(output.records[0].points[1],[100,0]);
  const updated=calibrateScale({id:'page-1',pageIndex:0,points:[[0,0],[100,0]],distance:20,unit:'ft'});
  const changed=validateTakeoff({scales:[updated],records:output.records},1);
  assert.ok(Math.abs(measure({...changed.records[0],scales:changed.scales}).value-20)<1e-12);
});

test('takeoff rejects uncalibrated distances, stale evidence, invalid pages and malformed records', () => {
  assert.throws(()=>validateTakeoff({scales:[],records:[record()]},1),/calibration/);
  const tampered=scale();tampered.metersPerPdfUnit*=2;
  assert.throws(()=>validateTakeoff({scales:[tampered],records:[]},1),/reference|evidence|ratio/i);
  const invalids=[
    {...record(),pageIndex:1}, {...record(),unit:'survey-ft'}, {...record(),kind:'eval'},
    {...record(),points:[[NaN,0],[1,0]]}, {...record(),points:[[0,0,1],[1,0]]},
    {...record(),depth:{value:0,unit:'m'}}, {...record(),id:''}
  ];
  for(const invalid of invalids)assert.throws(()=>validateTakeoff({scales:[scale()],records:[invalid]},1));
  assert.throws(()=>validateTakeoff({scales:[scale()],records:[record(),record()]},1),/duplicate/);
});

test('scale-free counts and angles persist; volume requires a positive dimensional depth', () => {
  const counts={...record(),kind:'count',points:[[1,1],[2,2],[3,3]]};
  const angles={...record(),id:'angle',kind:'angle',points:[[0,1],[0,0],[1,0]]};
  const unscaled=validateTakeoff({scales:[],records:[counts,angles]},1);
  assert.deepEqual(unscaled.records.map(record=>measure({...record,scales:[]}).value),[3,90]);
  const volume={...record(),kind:'volume',points:[[0,0],[100,0],[100,100],[0,100]],depth:{value:2,unit:'ft'}};
  const output=validateTakeoff({scales:[scale()],records:[volume]},1);
  assert.ok(Math.abs(measure({...output.records[0],scales:output.scales}).value-200)<1e-10);
  delete volume.depth;
  assert.throws(()=>validateTakeoff({scales:[scale()],records:[volume]},1),/depth/);
});

test('takeoff workspace rejects excessive records and coordinate totals', () => {
  const count={...record(),kind:'count',points:[[0,0]]};
  assert.throws(()=>validateTakeoff({scales:[],records:Array.from({length:10001},(_,index)=>({...count,id:String(index)}))},1),/10,000/);
  const points=Array.from({length:10000},(_,n)=>[n,0]);
  assert.throws(()=>validateTakeoff({scales:[],records:Array.from({length:11},(_,index)=>({...count,id:String(index),points}))},1),/100,000/);
});
