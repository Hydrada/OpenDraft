import test from 'node:test';
import assert from 'node:assert/strict';
import { snapPick } from '../apps/opendraft/src/measurement-snapping.ts';

test('vertex snapping chooses the nearest candidate inside tolerance only',()=>{
  const vertices=[[100,100],[104,100],[300,300]];
  assert.deepEqual(snapPick([103,101],{tolerance:8,vertices}),{point:[104,100],kind:'vertex',distance:Math.hypot(1,1)});
  assert.equal(snapPick([120,100],{tolerance:8,vertices}).kind,'none');
  assert.equal(snapPick([108,100],{tolerance:8,vertices}).kind,'vertex');
  assert.equal(snapPick([108.01,100],{tolerance:0,vertices}).kind,'none');
  const copy=snapPick([300,301],{tolerance:8,vertices}).point;copy[0]=0;
  assert.deepEqual(vertices[2],[300,300]);
});

test('orthogonal constraint follows the dominant screen axis and yields to vertices',()=>{
  const anchor=[50,50];
  assert.deepEqual(snapPick([150,57],{tolerance:8,vertices:[],anchor,orthogonal:true}).point,[150,50]);
  assert.deepEqual(snapPick([44,-90],{tolerance:8,vertices:[],anchor,orthogonal:true}).point,[50,-90]);
  assert.equal(snapPick([150,57],{tolerance:8,vertices:[[152,58]],anchor,orthogonal:true}).kind,'vertex');
  assert.deepEqual(snapPick([150,57],{tolerance:8,vertices:[],anchor}).point,[150,57]);
  assert.equal(snapPick([150,57],{tolerance:8,vertices:[],orthogonal:true}).kind,'none');
});

test('invalid inputs are rejected and non-finite candidates ignored',()=>{
  assert.throws(()=>snapPick([NaN,0],{tolerance:8,vertices:[]}),/finite/);
  assert.throws(()=>snapPick([0,0],{tolerance:-1,vertices:[]}),/tolerance/);
  assert.throws(()=>snapPick([0,0],{tolerance:Infinity,vertices:[]}),/tolerance/);
  assert.equal(snapPick([0,0],{tolerance:8,vertices:[[NaN,0],[Infinity,1]]}).kind,'none');
});
