import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRasters, comparisonGeometry, COMPARISON_LIMITS } from '../apps/opendraft/src/revision-comparison.ts';

const raster = (width, height, pixels) => ({ width, height, data: new Uint8ClampedArray(pixels.flat()) });
const white = [255, 255, 255, 255], black = [0, 0, 0, 255];
const options = { offsetX: 0, offsetY: 0, threshold: 0 };
const pixel = (bytes, index) => [...bytes.slice(index * 4, index * 4 + 4)];

test('known additions, removals and shared linework produce deterministic colors and exact bounds', () => {
  const base = raster(4, 1, [black, white, black, white]);
  const revision = raster(4, 1, [white, black, black, white]);
  const before = structuredClone({ base, revision, options });
  const result = compareRasters(base, revision, options);
  assert.deepEqual([result.width, result.height, result.originX, result.originY], [4, 1, 0, 0]);
  assert.equal(result.changedPixels, 2); assert.equal(result.totalPixels, 4);
  assert.deepEqual(result.changedBounds, { x: 0, y: 0, width: 2, height: 1 });
  assert.deepEqual([...result.overlay], [255,0,0,255, 0,0,255,255, 0,0,0,255, 255,255,255,255]);
  assert.deepEqual([...result.difference], [220,35,45,255, 25,80,220,255, 224,224,224,255, 255,255,255,255]);
  assert.deepEqual({ base, revision, options }, before);
});

test('threshold is max RGB difference and inclusive equality is unchanged, independently of luminance', () => {
  const base = raster(1, 1, [[100, 100, 100, 255]]);
  const revision = raster(1, 1, [[110, 100, 100, 255]]);
  assert.equal(compareRasters(base, revision, {...options, threshold: 9}).changedPixels, 1);
  const equal = compareRasters(base, revision, {...options, threshold: 10});
  assert.equal(equal.changedPixels, 0); assert.equal(equal.changedBounds, null);
  assert.equal(compareRasters(base, revision, {...options, threshold: 255}).changedPixels, 0);
  // These unequal RGB colors have the same rounded grayscale (1), so neither is darker.
  const sameGray = compareRasters(raster(1,1,[[0,1,0,255]]), raster(1,1,[[3,0,0,255]]), options);
  assert.equal(sameGray.changedPixels, 1);
  assert.deepEqual(pixel(sameGray.difference, 0), [180,40,180,255]);
});

test('alpha is composited over white and transparent hidden RGB never creates a difference', () => {
  const transparent = raster(1, 1, [[0, 80, 220, 0]]);
  const blank = raster(1, 1, [white]);
  assert.equal(compareRasters(transparent, blank, options).changedPixels, 0);
  const halfBlack = raster(1, 1, [[0, 0, 0, 128]]);
  const opaqueEquivalent = raster(1, 1, [[127, 127, 127, 255]]);
  const result = compareRasters(halfBlack, opaqueEquivalent, options);
  assert.equal(result.changedPixels, 0);
  assert.deepEqual(pixel(result.overlay, 0), [127,63,127,255]);
});

test('signed translation retains all page pixels and expresses changed bounds in union coordinates', () => {
  const one = raster(1, 1, [black]);
  for (const [offsetX,offsetY,originX,originY] of [[2,1,0,0],[-2,-1,-2,-1],[2,-1,0,-1],[-2,1,-2,0]]) {
    const result = compareRasters(one, one, {offsetX,offsetY,threshold:0});
    assert.deepEqual([result.width,result.height,result.originX,result.originY], [3,2,originX,originY]);
    assert.equal(result.changedPixels, 2); assert.equal(result.totalPixels, 6);
    assert.deepEqual(result.changedBounds, {x:0,y:0,width:3,height:2});
    const baseIndex = (-originY * result.width) - originX;
    const revisionIndex = ((offsetY-originY) * result.width) + offsetX-originX;
    assert.deepEqual(pixel(result.difference,baseIndex), [220,35,45,255]);
    assert.deepEqual(pixel(result.difference,revisionIndex), [25,80,220,255]);
  }
});

test('different dimensions use white outside pages and comparison can cancel a known translation', () => {
  const base = raster(3, 1, [white, black, white]);
  const revision = raster(1, 1, [black]);
  assert.equal(compareRasters(base, revision, options).changedPixels, 2);
  const aligned = compareRasters(base, revision, {...options, offsetX: 1});
  assert.equal(aligned.changedPixels, 0); assert.equal(aligned.changedBounds, null);
  assert.deepEqual([...aligned.overlay], [255,255,255,255, 0,0,0,255, 255,255,255,255]);
  const whiteExtra = compareRasters(raster(1,1,[white]), raster(2,1,[white,white]), options);
  assert.equal(whiteExtra.changedPixels, 0);
  assert.equal(whiteExtra.width, 2);
});

test('budgets and integer geometry reject before raster access or output allocation', () => {
  const getData = () => { throw new Error('Raster bytes should not be inspected'); };
  const oversized = { width: 2001, height: 2000, get data(){ return getData(); } };
  assert.throws(() => compareRasters(oversized, oversized, options), /budget/);
  assert.deepEqual(comparisonGeometry({width:2000,height:2000},{width:1,height:1},0,0), {width:2000,height:2000,originX:0,originY:0});
  assert.equal(COMPARISON_LIMITS.maxPixels, 4_000_000);
  assert.throws(() => comparisonGeometry({width:2000,height:2000},{width:1,height:1},2000,0), /budget/);
  assert.throws(() => comparisonGeometry({width:8193,height:1},{width:1,height:1},0,0), /budget/);
  for (const invalid of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => comparisonGeometry({width:invalid,height:1},{width:1,height:1},0,0), /dimensions/);
  }
  for (const invalid of [0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => comparisonGeometry({width:1,height:1},{width:1,height:1},invalid,0), /integer/);
    assert.throws(() => comparisonGeometry({width:1,height:1},{width:1,height:1},0,invalid), /integer/);
  }
  assert.throws(() => comparisonGeometry({width:1,height:1},{width:1,height:1},Number.MAX_SAFE_INTEGER,0), /budget/);
});

test('invalid raster storage and thresholds fail without silently padding, truncating or coercing', () => {
  const valid = raster(1,1,[black]);
  for (const data of [new Uint8Array(4), new Uint8ClampedArray(3), new Uint8ClampedArray(5), [0,0,0,255], null]) {
    assert.throws(() => compareRasters({...valid,data},valid,options), /RGBA/);
    assert.throws(() => compareRasters(valid,{...valid,data},options), /RGBA/);
  }
  for (const threshold of [-1,256,0.5,NaN,Infinity,'1',undefined]) {
    assert.throws(() => compareRasters(valid,valid,{...options,threshold}), /threshold/);
  }
  assert.throws(() => compareRasters(valid,valid,null), /threshold/);
});
