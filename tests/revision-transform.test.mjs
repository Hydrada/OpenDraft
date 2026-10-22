import test from 'node:test';
import assert from 'node:assert/strict';
import {affineGeometry, transformForComparison, validateAffineTransform, similarityTransform} from '../apps/opendraft/src/revision-transform.ts';
import {compareRasters} from '../apps/opendraft/src/revision-comparison.ts';

const I = [1,0,0,1,0,0], white = [255,255,255,255], black = [0,0,0,255];
const raster = (width, height, pixels) => ({width, height, data: new Uint8ClampedArray(pixels.flat())});
const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('known transformed corner extents include every page through scale, quarter turns and negative offsets', () => {
  assert.deepEqual(affineGeometry({width:4,height:3},{width:2,height:1},I), {width:4,height:3,originX:0,originY:0});
  assert.deepEqual(affineGeometry({width:4,height:3},{width:2,height:1},[0,1,-1,0,0,0]), {width:5,height:3,originX:-1,originY:0});
  assert.deepEqual(affineGeometry({width:1,height:1},{width:2,height:3},[2,0,0,2,-0.25,-0.75]), {width:5,height:7,originX:-1,originY:-1});
  assert.deepEqual(affineGeometry({width:2,height:2},{width:2,height:2},[1,0,0.5,1,0,0]), {width:3,height:2,originX:0,originY:0});
});

test('similarity transform rotates clockwise about top-left and makes exact quarter turns without floating extents', () => {
  assert.deepEqual(similarityTransform({scale:1,rotationDegrees:90,offsetX:2,offsetY:3}), [0,1,-1,0,2,3]);
  assert.deepEqual(similarityTransform({scale:2,rotationDegrees:-90,offsetX:0,offsetY:0}), [0,-2,2,0,0,0]);
  assert.deepEqual(similarityTransform({scale:1,rotationDegrees:3600,offsetX:0,offsetY:0}), I);
  assert.deepEqual(affineGeometry({width:1,height:1},{width:2,height:3},similarityTransform({scale:1,rotationDegrees:90,offsetX:3,offsetY:0})), {width:3,height:2,originX:0,originY:0});
});

test('identity and integer translations exactly reproduce the existing comparison, including alpha and signed offsets', () => {
  const base = raster(2,2,[black,white,[200,50,10,128],white]);
  const revision = raster(2,1,[[0,200,40,0],[40,80,120,128]]);
  const before = structuredClone({base,revision});
  for (const [offsetX,offsetY] of [[0,0],[-2,1],[3,-1],[-1,-3]]) {
    const direct = compareRasters(base,revision,{offsetX,offsetY,threshold:0});
    const transformed = transformForComparison(base,revision,[1,0,0,1,offsetX,offsetY]);
    const actual = compareRasters(transformed.base,transformed.revision,{offsetX:0,offsetY:0,threshold:0});
    assert.deepEqual(transformed.geometry,{width:direct.width,height:direct.height,originX:direct.originX,originY:direct.originY});
    assert.deepEqual(actual.overlay,direct.overlay); assert.deepEqual(actual.difference,direct.difference);
    assert.equal(actual.changedPixels,direct.changedPixels); assert.deepEqual(actual.changedBounds,direct.changedBounds);
  }
  assert.deepEqual({base,revision},before);
});

test('a known 90-degree rotation moves asymmetric colored pixels to exact destinations', () => {
  const base = raster(1,1,[white]), revision = raster(2,1,[[255,0,0,255],[0,0,255,255]]);
  const matrix = [0,1,-1,0,1,0], snapshot = [...matrix];
  const result = transformForComparison(base,revision,matrix);
  assert.deepEqual(result.geometry,{width:1,height:2,originX:0,originY:0});
  assert.deepEqual(pixel(result.revision,0,0),[255,0,0,255]);
  assert.deepEqual(pixel(result.revision,0,1),[0,0,255,255]);
  assert.deepEqual(matrix,snapshot);
});

test('subpixel translation bilinearly samples white outside, compositing alpha before interpolation', () => {
  const base = raster(1,1,[white]);
  const blackShift = transformForComparison(base,raster(1,1,[black]),[1,0,0,1,0.5,0]);
  assert.deepEqual(pixel(blackShift.revision,0,0),[128,128,128,255]);
  assert.deepEqual(pixel(blackShift.revision,1,0),[128,128,128,255]);
  const transparentShift = transformForComparison(base,raster(1,1,[[0,0,0,0]]),[1,0,0,1,0.5,0]);
  assert.deepEqual(pixel(transparentShift.revision,0,0),white);
  const halfBlack = transformForComparison(base,raster(1,1,[[0,0,0,128]]),[1,0,0,1,0.5,0]);
  assert.deepEqual(pixel(halfBlack.revision,0,0),[191,191,191,255]);
});

test('invalid transforms and input/union budgets fail before source raster access', () => {
  const unread = {width:2,height:2,get data(){throw new Error('Raster must not be read');}};
  for (const matrix of [null,[],[1,0,0,1,0],[1,0,0,1,0,0,0],[1,0,0,1,NaN,0],[1,0,0,1,Infinity,0],['1',0,0,1,0,0]]) {
    assert.throws(()=>transformForComparison(unread,unread,matrix),/six finite/);
  }
  for (const matrix of [[-1,0,0,1,0,0],[0,0,0,0,0,0],[1,1,1,1,0,0]]) {
    assert.throws(()=>transformForComparison(unread,unread,matrix),/orientation|nondegenerate/);
  }
  for (const matrix of [[0.09,0,0,1,0,0],[11,0,0,1,0,0],[1,0,100,1,0,0],[1,0,0,1,100001,0]]) {
    assert.throws(()=>transformForComparison(unread,unread,matrix),/scales|offsets/);
  }
  assert.throws(()=>transformForComparison({width:2001,height:2000,get data(){throw new Error('Raster must not be read');}},unread,I),/budget/);
  assert.throws(()=>transformForComparison(unread,unread,[1,0,0,1,8192,0]),/budget/);
  assert.throws(()=>affineGeometry({width:2000,height:2000},{width:1,height:1},[1,0,0,1,2000,0]),/budget/);
  assert.deepEqual(validateAffineTransform([0.1,0,0,10,0,0]),[0.1,0,0,10,0,0]);
});

test('malformed raster storage and invalid similarity settings fail rather than padding or coercing', () => {
  const valid = raster(1,1,[black]);
  for (const data of [new Uint8Array(4),new Uint8ClampedArray(3),new Uint8ClampedArray(5),null]) {
    assert.throws(()=>transformForComparison({...valid,data},valid,I),/RGBA/);
    assert.throws(()=>transformForComparison(valid,{...valid,data},I),/RGBA/);
  }
  const normal={scale:1,rotationDegrees:0,offsetX:0,offsetY:0};
  for (const options of [null,{...normal,scale:0.09},{...normal,scale:10.01},{...normal,rotationDegrees:3601},{...normal,rotationDegrees:NaN},{...normal,offsetX:Infinity}]) {
    assert.throws(()=>similarityTransform(options),/Similarity/);
  }
});
