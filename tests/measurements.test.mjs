import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateScale, validateScales, resolveScale, measure, verifyCalibration, calculateQuantity } from '../apps/opendraft/src/measurements.ts';
import * as mod from '../apps/opendraft/src/measurements.ts';

const scale=(extra={})=>calibrateScale({id:'page0',pageIndex:0,points:[[0,0],[100,0]],distance:10,unit:'m',...extra});
const result=(kind,points,extra={})=>measure({kind,points,pageIndex:0,scales:[scale()],...extra});
const near=(actual,expected,tolerance=1e-11)=>assert.ok(Math.abs(actual-expected)<=Math.max(1,Math.abs(expected))*tolerance,`${actual} != ${expected}`);

test('known-distance calibration retains evidence; recovered ratios cannot be forged',()=>{
  const reference=[[0,0],[100,0]],input={id:'reference',pageIndex:0,points:reference,distance:10,unit:'m'};
  const calibrated=calibrateScale(input);reference[0][0]=30;
  near(calibrated.metersPerPdfUnit,0.1);assert.equal(calibrated.reference.points[0][0],0);
  const checked=validateScales([calibrated],1);checked[0].reference.points[0][0]=5;
  assert.equal(calibrated.reference.points[0][0],0);
  assert.throws(()=>validateScales([{...calibrated,metersPerPdfUnit:0.2}],1),/does not match/);
  assert.throws(()=>validateScales([calibrated,calibrated],1),/Duplicate/);
  assert.throws(()=>validateScales([calibrated,{...calibrated,id:'other'}],1),/only one/);
  assert.throws(()=>validateScales([{...calibrated,pageIndex:1}],1),/invalid page/);
  const forgedReference={...calibrated,reference:{...calibrated.reference,id:'injected',pageIndex:999}};
  assert.equal(validateScales([forgedReference],1)[0].id,'reference');
  assert.equal(validateScales([forgedReference],1)[0].pageIndex,0);
  assert.equal('id' in validateScales([forgedReference],1)[0].reference,false);
});

test('length and polyline reference geometry use SI and exact international imperial definitions',()=>{
  near(result('length',[[0,0],[30,40]]).value,5);
  near(result('polyline',[[0,0],[30,0],[30,40]]).value,7);
  near(result('length',[[0,0],[100,0]],{unit:'mm'}).value,10000);
  for(const [unit,meters]of [['mm',0.001],['cm',0.01],['m',1],['km',1000],['in',0.0254],['ft',0.3048],['yd',0.9144]])near(result('length',[[0,0],[100,0]],{unit}).value,10/meters);
  near(result('length',[[0,0],[36,0]],{scales:[scale({distance:100,unit:'in'})],unit:'yd'}).value,1);
});

test('simple polygon area, perimeter and mixed-depth volume match hand calculations',()=>{
  const rectangle=[[0,0],[40,0],[40,30],[0,30]],triangle=[[0,0],[40,0],[0,30]];
  near(result('area',rectangle).value,12);near(result('perimeter',rectangle).value,14);
  near(result('area',triangle).value,6);near(result('area',[...rectangle].reverse()).value,12);
  near(result('area',[...rectangle,rectangle[0]]).value,12);
  near(result('volume',rectangle,{depth:{value:250,unit:'mm'}}).value,3);
  near(result('area',rectangle,{unit:'ft'}).value,12/(0.3048**2));
  near(result('volume',rectangle,{unit:'yd',depth:{value:1,unit:'ft'}}).value,12*0.3048/(0.9144**3));
  assert.equal(result('volume',rectangle,{unit:'ft',depth:{value:1,unit:'m'}}).unit,'ft³');
});

test('concave polygon and translated large-origin geometry avoid shoelace cancellation',()=>{
  const concave=[[0,0],[40,0],[40,10],[10,10],[10,40],[0,40]];
  near(result('area',concave).value,7);
  const translated=concave.map(([x,y])=>[x+900000000,y+900000000]);
  near(result('area',translated).value,7);
});

test('rotation and translation do not change calibrated reference measurements',()=>{
  const points=[[0,0],[30,0],[30,40]],radians=0.713;
  const rotate=([x,y])=>[x*Math.cos(radians)-y*Math.sin(radians)+1234,x*Math.sin(radians)+y*Math.cos(radians)-4321];
  const rotatedScale=scale({points:[[0,0],[100,0]].map(rotate)});
  near(result('polyline',points.map(rotate),{scales:[rotatedScale]}).value,7);
});

test('angles use middle-point vertex and counts are scale independent',()=>{
  near(result('angle',[[1,0],[0,0],[0,1]],{scales:[]}).value,90);
  near(result('angle',[[1,0],[0,0],[-1,0]],{scales:[]}).value,180);
  near(result('angle',[[1,0],[0,0],[1,1]],{scales:[]}).value,45);
  assert.equal(result('count',[[1,1],[2,2],[1,1]],{scales:[]}).value,3);
  assert.throws(()=>result('angle',[[0,0],[0,0],[1,1]]),/degenerate/);
});

test('viewport precedence is explicit; boundary, crossings, overlaps and missing scales are safe',()=>{
  const page=scale(),detail=scale({id:'detail',viewport:[20,20,80,80],points:[[20,20],[80,20]],distance:12});
  const scales=[page,detail];
  assert.equal(resolveScale(scales,0,[[20,20],[80,20]]).id,'detail');
  near(result('length',[[20,20],[80,20]],{scales}).value,12);
  assert.equal(resolveScale(scales,0,[[0,0],[10,10]]).id,'page0');
  for(const points of [[[0,50],[100,50]],[[0,0],[20,20]],[[30,30],[90,30]]])assert.throws(()=>resolveScale(scales,0,points),/Ambiguous/);
  const overlap=scale({id:'overlap',viewport:[50,50,100,100],points:[[50,50],[100,50]],distance:5});
  assert.throws(()=>resolveScale([...scales,overlap],0,[[60,60],[70,70]]),/Ambiguous/);
  assert.throws(()=>resolveScale(scales,1,[[0,0],[10,10]]),/No calibration/);
});

test('area enclosing a different-scale inset rejects even without an edge crossing',()=>{
  const detail=scale({id:'inset',viewport:[20,20,40,40],points:[[20,20],[40,20]],distance:4}),scales=[scale(),detail];
  const boundary=[[0,0],[100,0],[100,100],[0,100]];
  assert.throws(()=>result('area',boundary,{scales}),/encloses/);
  near(result('perimeter',boundary,{scales}).value,40);
});

test('invalid or touching/selfcrossing polygons and nonfinite inputs fail explicitly',()=>{
  for(const points of [[[0,0],[40,40],[0,40],[40,0]],[[0,0],[40,0],[20,0]],[[0,0],[40,0],[40,0],[0,40]],[[0,0],[40,0],[20,0],[20,20],[0,20]]])assert.throws(()=>result('area',points));
  for(const input of [{distance:0},{points:[[1,1],[1,1]]},{unit:'survey-ft'},{viewport:[0,0,0,10]},{viewport:[0,0,10,10],points:[[0,0],[100,0]]}])assert.throws(()=>scale(input));
  assert.throws(()=>result('length',[[0,0],[Infinity,0]]));assert.throws(()=>result('length',[[0,0],[0,0]]));
  assert.throws(()=>result('volume',[[0,0],[20,0],[20,20]],{depth:{value:-1,unit:'m'}}));
  assert.throws(()=>calculateQuantity({measurement:1e18,multiplier:2}),/range/);
});

test('independent reference verification enforces 0.1 percent tolerance; quantity arithmetic is bounded',()=>{
  const checked=verifyCalibration(scale(),{points:[[0,0],[30,40]],distance:5,unit:'m'});
  assert.equal(checked.passed,true);near(checked.relativeError,0);
  assert.equal(verifyCalibration(scale(),{points:[[0,0],[30,40]],distance:5.02,unit:'m'}).passed,false);
  near(calculateQuantity({measurement:12,multiplier:3,wastePercent:10}),39.6);
  assert.throws(()=>calculateQuantity({measurement:10,wastePercent:-1}));
  assert.throws(()=>verifyCalibration(scale(),{points:[[0,0],[30,40]],distance:5,unit:'m',tolerance:0.5}));
});

test('independent verification rejects the calibration pair in either direction and near-coincident copies',()=>{
  const calibrated=scale();
  const [a,b]=calibrated.reference.points;
  for(const points of [[a,b],[b,a],[[a[0]+1e-8,a[1]],b]])
    assert.throws(()=>verifyCalibration(calibrated,{points,distance:calibrated.reference.distance,unit:calibrated.reference.unit}),/different known reference/);
  const translated=calibrated.reference.points.map(([x,y])=>[x,y+20]);
  assert.equal(verifyCalibration(calibrated,{points:translated,distance:calibrated.reference.distance,unit:calibrated.reference.unit}).passed,true);
});

test('radius, diameter and arc length use the calibrated scale and reject degenerate input',()=>{
  // 0.1 m per PDF unit. Circle of radius 50 units (5 m) centred at (100,100).
  near(result('radius',[[100,100],[130,140]]).value,5);
  near(result('diameter',[[100,100],[150,100]]).value,10);
  // Quarter circle from (150,100) through 45° to (100,150): (π/2)·5 m.
  const mid=[100+50*Math.SQRT1_2,100+50*Math.SQRT1_2];
  near(result('arc',[[150,100],mid,[100,150]]).value,Math.PI/2*5);
  // Same endpoints through the far side: the other three quarters.
  near(result('arc',[[150,100],[50,100],[100,150]]).value,3*Math.PI/2*5);
  // Half circle, clockwise through the bottom.
  near(result('arc',[[150,100],[100,50],[50,100]]).value,Math.PI*5);
  assert.equal(result('radius',[[0,0],[10,0]]).unit,'m');
  assert.throws(()=>result('radius',[[0,0],[0,0]]),/degenerate/);
  assert.throws(()=>result('radius',[[0,0],[1,0],[2,0]]),/centre point/);
  assert.throws(()=>result('arc',[[0,0],[1,1],[2,2]]),/collinear/);
});

test('area cutouts are deducted, must sit inside the outline and must not overlap',()=>{
  // 0.1 m per unit: 200x100 outline = 200 m²; 20x20 and 10x30 openings = 4 m² + 3 m².
  const outline=[[0,0],[200,0],[200,100],[0,100]],a=[[20,20],[40,20],[40,40],[20,40]],b=[[100,10],[110,10],[110,40],[100,40]];
  near(result('area',outline,{cutouts:[a,b]}).value,193);
  near(result('volume',outline,{cutouts:[a],depth:{value:2,unit:'m'}}).value,392);
  assert.throws(()=>result('area',outline,{cutouts:[[[190,90],[250,90],[250,95]]]}),/inside the measured outline/);
  assert.throws(()=>result('area',outline,{cutouts:[a,[[25,25],[35,25],[35,35]]]}),/overlaps/);
  assert.throws(()=>result('length',[[0,0],[10,0]],{cutouts:[a]}),/only to area and volume/);
});

test('sketch to scale places the end point exactly the requested real length away',()=>{
  const { sketchEndpoint } = mod;
  const end=sketchEndpoint([scale()],0,[10,20],5,'m',0); // 0.1 m per unit: 5 m = 50 units
  near(end[0],60);near(end[1],20);
  const up=sketchEndpoint([scale()],0,[0,0],2,'m',90);near(up[0],0);near(up[1],20);
  near(result('length',[[0,0],sketchEndpoint([scale()],0,[0,0],7.5,'m',37)]).value,7.5);
  assert.throws(()=>sketchEndpoint([scale()],0,[0,0],0,'m',0),/positive/);
});
