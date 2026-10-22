import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractDrawingVertices, PathOps } from '../apps/opendraft/src/drawing-geometry.ts';

const path=(paint,...data)=>[PathOps.constructPath,[paint,[Float32Array.from(data)],null]];
const list=(...entries)=>({fnArray:entries.map(entry=>entry[0]),argsArray:entries.map(entry=>entry[1])});

test('painted endpoints follow CTM through save/restore and forms; clip paths and controls are ignored',()=>{
  const result=extractDrawingVertices(list(
    path(20,0,1,2,1,3,4),
    [PathOps.save,null],[PathOps.transform,[2,0,0,2,10,10]],path(20,0,1,1,1,2,1),[PathOps.restore,null],
    path(28,0,500,500,1,600,600),
    [PathOps.formBegin,[[1,0,0,1,100,0],null]],path(22,0,0,0,2,5,5,6,6,7,7,4),[PathOps.formEnd,null],
    path(20,0,1,2),
  ));
  assert.deepEqual(result.points,[[1,2],[3,4],[12,12],[14,12],[100,0],[107,7]]);
  assert.equal(result.truncated,false);assert.equal(result.skippedPaths,0);
});

test('limits, malformed data and invalid arguments are bounded',()=>{
  const many=extractDrawingVertices(list(path(20,0,0,0,1,1,1,1,2,2)),2);
  assert.equal(many.points.length,2);assert.equal(many.truncated,true);
  assert.equal(extractDrawingVertices(list(path(20,9,1,1),[PathOps.constructPath,[20,[],null]])).skippedPaths,2);
  assert.deepEqual(extractDrawingVertices(list([PathOps.transform,[NaN,0,0,1,0,0]],path(20,0,3,3))).points,[[3,3]]);
  assert.throws(()=>extractDrawingVertices(list(),0),/limit/);
});

test('real PDF.js operator list yields transformed line endpoints in PDF user space',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([400,400]);
  page.drawLine({start:{x:10,y:20},end:{x:110,y:20},thickness:1,color:rgb(0,0,0)});
  page.pushOperators(pushGraphicsState(),concatTransformationMatrix(0,1,-1,0,300,0));
  page.drawLine({start:{x:0,y:0},end:{x:50,y:0},thickness:1,color:rgb(0,0,0)});
  page.pushOperators(popGraphicsState());
  const doc=await pdfjs.getDocument({data:await pdf.save()}).promise;
  const ops=await (await doc.getPage(1)).getOperatorList({annotationMode:pdfjs.AnnotationMode.DISABLE});
  const points=extractDrawingVertices(ops).points.map(point=>point.map(value=>Math.round(value*1000)/1000));
  assert.deepEqual(points,[[10,20],[110,20],[300,0],[300,50]]);
  await doc.cleanup();
});

test('derived snap points include segment midpoints and crossings, not duplicated endpoints',()=>{
  // Room outline 0..100 x 0..80 with an interior wall x=40 (full height) and y=50 (full width).
  const result=extractDrawingVertices(list(path(20,0,0,0,1,100,0,1,100,80,1,0,80,4),path(20,0,40,0,1,40,80),path(20,0,0,50,1,100,50)));
  const has=(x,y)=>result.derived.some(([px,py])=>Math.abs(px-x)<1e-9&&Math.abs(py-y)<1e-9);
  assert.ok(has(40,50),'interior crossing');
  assert.ok(has(50,0)&&has(100,40)&&has(40,40)&&has(50,80),'midpoints');
  assert.ok(!result.derived.some(([x,y])=>result.points.some(([px,py])=>px===x&&py===y)),'no duplicates of endpoints');
  assert.equal(result.derivedTruncated,false);
  const parallel=extractDrawingVertices(list(path(20,0,0,0,1,10,0),path(20,0,0,1,1,10,1)));
  assert.deepEqual(parallel.derived.map(([x,y])=>[x,y]),[[5,0],[5,1]]);
});

test('geometry on hidden optional-content layers is skipped when visibility is supplied', () => {
  const marked = (props, ...ops) => [[PathOps.beginMarkedContentProps, ['OC', props]], ...ops, [PathOps.endMarkedContent, null]];
  const ops = list(path(20, 0, 0, 0, 1, 10, 0), ...marked({ id: 'hidden' }, path(20, 0, 50, 50, 1, 60, 50)), ...marked({ id: 'shown' }, path(20, 0, 80, 80, 1, 90, 80)), [PathOps.beginMarkedContentProps, ['Artifact', {}]], path(20, 0, 5, 5, 1, 6, 5), [PathOps.endMarkedContent, null]);
  const all = extractDrawingVertices(ops).points;
  const visible = extractDrawingVertices(ops, undefined, props => props.id !== 'hidden').points;
  assert.equal(all.length, 8);
  assert.deepEqual(visible.map(p => p.join(',')), ['0,0', '10,0', '80,80', '90,80', '5,5', '6,5']);
});

test('curves meeting straight lines yield intersection snap points (not curve-piece midpoints)', () => {
  // Quarter-circle-ish cubic from (0,100) to (100,0) bulging toward (100,100); a horizontal line y=50 crosses it.
  const k = 55.23;
  const ops = list(path(20, 0, 0, 100, 2, k, 100, 100, k, 100, 0), path(20, 0, 0, 50, 1, 120, 50));
  const result = extractDrawingVertices(ops);
  const crossings = result.derived.filter(([, y]) => Math.abs(y - 50) < 1e-6 && result.derived.length);
  const onCurve = crossings.filter(([x]) => x > 80 && x < 95);
  assert.equal(onCurve.length, 1, JSON.stringify(crossings));
  // Exact crossing of the true curve with y=50 is at x ≈ 86.6 (circle radius 100); flattened error stays small.
  assert.ok(Math.abs(onCurve[0][0] - 86.6) < 1.5, `x ${onCurve[0][0]}`);
  // Only the straight line contributes a midpoint.
  assert.equal(result.derived.filter(([x, y]) => Math.abs(x - 60) < 1e-9 && Math.abs(y - 50) < 1e-9).length, 1);
  assert.equal(result.derived.length, crossings.length);
});
