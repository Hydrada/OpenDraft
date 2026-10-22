import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateScale } from '../apps/opendraft/src/measurements.ts';
import { validateTakeoff, derivedQuantity, validateQuantityFormula } from '../apps/opendraft/src/takeoff.ts';
import { takeoffCsv } from '../apps/opendraft/src/takeoff-reports.ts';
import { validateMeasurementPresets, serializeMeasurementPresets, loadMeasurementPresets, measurementPresetKey } from '../apps/opendraft/src/measurement-presets.ts';

const scale=calibrateScale({id:'s',pageIndex:0,points:[[0,0],[100,0]],distance:10,unit:'m'});
const area={id:'a',label:'Slab',pageIndex:0,kind:'area',points:[[0,0],[100,0],[100,100],[0,100]],unit:'m',quantity:{multiplier:2,wastePercent:10,unitLabel:'bags'}};

test('derived quantity persists, recomputes and exports numerically',()=>{
  const state=validateTakeoff({scales:[scale],records:[area]},1);
  assert.deepEqual(state.records[0].quantity,{multiplier:2,wastePercent:10,unitLabel:'bags'});
  assert.ok(Math.abs(derivedQuantity(state.records[0],100)-220)<1e-9);
  assert.equal(derivedQuantity({...state.records[0],quantity:undefined},100),undefined);
  const csv=takeoffCsv('a.pdf',1,state).split('\r\n');
  assert.match(csv[0],/"Quantity multiplier","Waste percent","Derived quantity","Derived unit","Cutouts JSON","Space"$/);
  assert.ok(Math.abs(Number(csv[1].split(",").at(-4).replaceAll("\"",""))-220)<1e-9);
  assert.match(csv[1],/"bags","",""$/);
});

test('formula validation rejects unsafe or degenerate inputs',()=>{
  for(const bad of [null,{multiplier:0,wastePercent:0,unitLabel:''},{multiplier:NaN,wastePercent:0,unitLabel:''},{multiplier:2e9,wastePercent:0,unitLabel:''},
    {multiplier:1,wastePercent:-1,unitLabel:''},{multiplier:1,wastePercent:2000,unitLabel:''},{multiplier:1,wastePercent:0,unitLabel:'x\u0007'},{multiplier:'2',wastePercent:0,unitLabel:''}])
    assert.throws(()=>validateQuantityFormula(bad));
  assert.throws(()=>validateTakeoff({scales:[scale],records:[{...area,quantity:{multiplier:1,wastePercent:0}}]},1),/formula/);
});

test('presets are versioned, bounded, deduplicated and never carry geometry',()=>{
  const preset={name:' Concrete ',kind:'volume',label:'Footing',unit:'ft',depth:{value:1,unit:'ft'},quantity:{multiplier:0.037,wastePercent:5,unitLabel:'yd3'},points:[[1,1]]};
  const [canonical]=validateMeasurementPresets({schema:'opendraft.measurement-presets',version:1,presets:[preset]});
  assert.equal(canonical.name,'Concrete');assert.equal('points' in canonical,false);
  assert.throws(()=>validateMeasurementPresets({schema:'opendraft.measurement-presets',version:2,presets:[]}),/version 1/);
  assert.throws(()=>validateMeasurementPresets({schema:'opendraft.measurement-presets',version:1,presets:[preset,{...preset,name:'concrete'}]}),/duplicate/);
  assert.throws(()=>validateMeasurementPresets({schema:'opendraft.measurement-presets',version:1,presets:[{...preset,kind:'area'}]}),/depth/);
  assert.throws(()=>validateMeasurementPresets({schema:'opendraft.measurement-presets',version:1,presets:Array(201).fill(preset)}),/200/);
  const store=new Map([[measurementPresetKey,serializeMeasurementPresets([canonical])]]);
  assert.deepEqual(loadMeasurementPresets({getItem:key=>store.get(key)??null}).presets,[canonical]);
  const broken=loadMeasurementPresets({getItem:()=>'{bad'});
  assert.deepEqual(broken.presets,[]);assert.match(broken.error,/ignored/);
});
