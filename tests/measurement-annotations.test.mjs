import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { calibrateScale } from '../apps/opendraft/src/measurements.ts';
import { applyMeasurementAnnotations } from '../apps/opendraft/src/measurement-annotations.ts';

const scale=calibrateScale({id:'s',pageIndex:0,points:[[0,0],[100,0]],distance:10,unit:'ft'});
const records=[
  {id:'l',label:'Wall',pageIndex:0,kind:'length',points:[[10,10],[110,10]],unit:'ft'},
  {id:'p',label:'Run',pageIndex:0,kind:'polyline',points:[[10,50],[60,50],[60,100]],unit:'ft'},
  {id:'a',label:'Room',pageIndex:0,kind:'area',points:[[200,200],[300,200],[300,300],[200,300]],unit:'ft',quantity:{multiplier:2,wastePercent:0,unitLabel:'tiles'}},
  {id:'c',label:'Outlets',pageIndex:0,kind:'count',points:[[1,1],[2,2]],unit:'ft'},
  {id:'g',label:'Corner',pageIndex:0,kind:'angle',points:[[0,0],[10,0],[10,10]],unit:'ft'},
];

test('takeoff exports standard dimension annotations with /Measure and leaves the source unchanged',async()=>{
  const source=await PDFDocument.create();source.addPage([400,400]);source.addPage([400,400]);
  const bytes=await source.save(),before=bytes.slice();
  const result=await applyMeasurementAnnotations(bytes,{scales:[scale],records});
  assert.deepEqual(bytes,before);
  assert.equal(result.written,3);
  assert.deepEqual(result.skipped.map(item=>item.id),['c','g']);
  const doc=await pdfjs.getDocument({data:result.bytes.slice()}).promise;
  const annotations=await (await doc.getPage(1)).getAnnotations();
  assert.deepEqual(annotations.map(item=>item.subtype),['Line','PolyLine','Polygon']);
  assert.deepEqual(annotations[0].lineCoordinates,[10,10,110,10]);
  assert.equal(annotations[0].contentsObj.str,'Wall: 10 ft');
  assert.equal(annotations[2].contentsObj.str,'Room: 100 ft² (200 tiles)');
  assert.equal((await (await doc.getPage(2)).getAnnotations()).length,0);
  await doc.cleanup();
  const parsed=await PDFDocument.load(result.bytes);
  const annots=parsed.getPage(0).node.Annots();
  const line=parsed.context.lookup(annots.get(0));
  assert.equal(line.get(PDFName.of('IT')).toString(),'/LineDimension');
  const measure=line.lookup(PDFName.of('Measure'));
  assert.equal(measure.get(PDFName.of('Subtype')).toString(),'/RL');
  const x=measure.lookup(PDFName.of('X')).lookup(0);
  assert.ok(Math.abs(x.get(PDFName.of('C')).asNumber()-0.1)<1e-12);
  const area=parsed.context.lookup(annots.get(2)).lookup(PDFName.of('Measure')).lookup(PDFName.of('A')).lookup(0);
  assert.ok(Math.abs(area.get(PDFName.of('C')).asNumber()-0.01)<1e-12);
  assert.ok(parsed.context.lookup(annots.get(2)).lookup(PDFName.of('AP')).get(PDFName.of('N')));
});

test('invalid takeoff is rejected before writing',async()=>{
  const source=await PDFDocument.create();source.addPage();
  await assert.rejects(applyMeasurementAnnotations(await source.save(),{scales:[],records:[{...records[0],pageIndex:4}]}));
});
