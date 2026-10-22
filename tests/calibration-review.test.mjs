import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewCalibrationChange} from '../apps/opendraft/src/calibration-review.ts';
import {calibrateScale} from '../apps/opendraft/src/measurements.ts';
const scale=(extra={})=>calibrateScale({id:'page',pageIndex:0,points:[[0,0],[100,0]],distance:10,unit:'m',...extra});
const record={id:'run',label:'Main',pageIndex:0,kind:'length',points:[[0,0],[50,0]],unit:'m'};
test('calibration review computes old/new quantities and evidence without mutating input',()=>{
  const input={scales:[scale()],records:[record]},before=JSON.stringify(input);
  const result=reviewCalibrationChange(input,[scale({distance:20})],1);
  assert.equal(result.impacts.length,1);
  assert.equal(result.impacts[0].before.value,5);
  assert.equal(result.impacts[0].after.value,10);
  assert.equal(result.impacts[0].beforeEvidence.reference.distance,10);
  assert.equal(result.impacts[0].afterEvidence.reference.distance,20);
  assert.equal(JSON.stringify(input),before);
  result.candidate.records[0].points[0][0]=20;
  assert.equal(input.records[0].points[0][0],0);
});
test('calibration evidence changes require review even when numeric quantities match',()=>{
  const input={scales:[scale()],records:[record,{...record,id:'count',kind:'count'}]};
  const result=reviewCalibrationChange(input,[scale({points:[[0,20],[100,20]]})],1);
  assert.deepEqual(result.impacts.map(row=>row.id),['run']);
  assert.equal(result.impacts[0].before.value,result.impacts[0].after.value);
  assert.equal(reviewCalibrationChange(input,[scale()],1).impacts.length,0);
});
test('ambiguous viewport candidates are rejected before approval and preserve input',()=>{
  const input={scales:[scale()],records:[record]},before=JSON.stringify(input);
  const viewport=scale({id:'inset',viewport:[20,-10,40,20],points:[[20,0],[40,0]],distance:4});
  assert.throws(()=>reviewCalibrationChange(input,[scale(),viewport],1),/viewport|ambig/i);
  assert.equal(JSON.stringify(input),before);
});
