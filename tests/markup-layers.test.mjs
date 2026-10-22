import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMarkupLayers,validateLayerAssignments,assignMarkupLayer,removeMarkupLayer} from '../apps/opendraft/src/markup-layers.ts';
import {groupMarkups,ungroupMarkups,updateMarkupSelection,lockMarkupSelection,translateMarkupSelection,deleteMarkupSelection} from '../apps/opendraft/src/markup-groups.ts';
const time='2026-10-21T12:00:00.000Z',later='2026-10-21T13:00:00.000Z';
const layer=(id,extra={})=>({id,name:`Layer ${id}`,visible:true,locked:false,...extra});
const mark=(id,extra={})=>({id,pageIndex:0,kind:'rectangle',points:[[40,50],[180,120]],color:[0.7,0.1,0.3],width:2,opacity:0.6,contents:`Review ${id}`,author:'Reviewer',status:'open',locked:false,createdAt:time,modifiedAt:time,...extra});
const layers=()=>[layer('a'),layer('b',{visible:false}),layer('empty')];
const marks=()=>[mark('one',{groupId:'group',layerId:'a'}),mark('two',{kind:'ellipse',groupId:'group',layerId:'a'}),mark('three')];

test('layer metadata is bounded, canonical and defensive with unique names and IDs',()=>{
 const input=[layer('a',{name:'  Cafe\u0301 review ',untrusted:'ignored'})],canonical=validateMarkupLayers(input);
 assert.deepEqual(canonical,[layer('a',{name:'Café review'})]);canonical[0].visible=false;assert.equal(input[0].visible,true);
 for(const value of [null,{},new Array(1),[null],[layer('bad/id')],[layer('a',{name:''})],[layer('a',{name:'x'.repeat(81)})],[layer('a',{name:'bad\nname'})],[layer('a',{visible:1})],[layer('a',{locked:'false'})],[layer('a'),layer('a',{name:'Other'})],[layer('a',{name:'Review'}),layer('b',{name:' review '})],[layer('a',{name:'Café'}),layer('b',{name:'CAFE\u0301'})]])assert.throws(()=>validateMarkupLayers(value));
 const atLimit=Array.from({length:256},(_,i)=>layer(`layer-${i}`));assert.equal(validateMarkupLayers(atLimit).length,256);assert.throws(()=>validateMarkupLayers([...atLimit,layer('extra')]),/256/);
});

test('layer membership references must exist and grouped annotations stay on one layer',()=>{
 const original=marks(),copy=validateLayerAssignments(original,layers(),1);
 assert.deepEqual(copy.map(mark=>mark.layerId),['a','a',undefined]);copy[0].points[0][0]=999;assert.equal(original[0].points[0][0],40);
 assert.throws(()=>validateLayerAssignments(original,[],1),/missing/);
 assert.throws(()=>validateLayerAssignments([mark('one',{layerId:'missing'})],layers(),1),/missing/);
 assert.throws(()=>validateLayerAssignments([mark('one',{groupId:'g',layerId:'a'}),mark('two',{groupId:'g',layerId:'b'})],layers(),1));
 assert.throws(()=>validateLayerAssignments([mark('one',{groupId:'g',layerId:'a'}),mark('two',{groupId:'g'})],layers(),1));
});

test('assignments expand complete groups and removal keeps individual annotations and membership',()=>{
 const original=marks(),metadata=layers(),before=structuredClone({original,metadata});
 const assigned=assignMarkupLayer(original,['two'],'b',metadata,1,later);
 assert.deepEqual(assigned.map(mark=>mark.layerId),['b','b',undefined]);assert.deepEqual(assigned.map(mark=>mark.contents),original.map(mark=>mark.contents));assert.equal(assigned[2].modifiedAt,time);
 const cleared=assignMarkupLayer(assigned,['one'],undefined,metadata,1,later);assert.ok(cleared.every(mark=>mark.layerId===undefined));assert.equal(cleared[0].groupId,'group');
 const removed=removeMarkupLayer(original,metadata,'a',1,later);
 assert.deepEqual(removed.layers.map(layer=>layer.id),['b','empty']);assert.equal(removed.markups.length,3);assert.ok(removed.markups.every(mark=>mark.layerId===undefined));assert.equal(removed.markups[1].groupId,'group');
 const emptyRemoved=removeMarkupLayer(original,metadata,'empty',1,later);assert.deepEqual(emptyRemoved.markups,original);
 assert.deepEqual({original,metadata},before);
});

test('layer and annotation locks reject assignment and removal atomically',()=>{
 const original=marks(),metadata=layers(),before=structuredClone(original);
 const sourceLocked=metadata.map(layer=>({...layer,locked:layer.id==='a'})),targetLocked=metadata.map(layer=>({...layer,locked:layer.id==='b'}));
 assert.throws(()=>assignMarkupLayer(original,['one'],'b',sourceLocked,1,later),/Unlock/);
 assert.throws(()=>assignMarkupLayer(original,['one'],'b',targetLocked,1,later),/Unlock/);
 assert.throws(()=>assignMarkupLayer(original.map(mark=>({...mark,locked:mark.id==='two'})),['one'],'b',metadata,1,later),/Unlock/);
 assert.throws(()=>removeMarkupLayer(original,sourceLocked,'a',1,later),/Unlock/);
 assert.throws(()=>removeMarkupLayer(original.map(mark=>({...mark,locked:mark.id==='two'})),metadata,'a',1,later),/Unlock/);
 assert.deepEqual(original,before);
});

test('all group actions enforce layer edit locks even when explicitly unlocking annotations',()=>{
 const original=marks(),metadata=layers().map(layer=>({...layer,locked:layer.id==='a'})),before=structuredClone(original);
 for(const action of [()=>groupMarkups(original,['one','two'],'new-group',1,later,metadata),()=>ungroupMarkups(original,['one'],1,later,metadata),()=>updateMarkupSelection(original,['two'],{width:3},1,later,metadata),()=>lockMarkupSelection(original,['one'],true,1,later,metadata),()=>lockMarkupSelection(original,['one'],false,1,later,metadata),()=>translateMarkupSelection(original,['two'],1,1,1,later,metadata),()=>deleteMarkupSelection(original,['one'],1,metadata)])assert.throws(action,/annotation layer/);
 assert.deepEqual(original,before);
 const unlocked=layers();assert.equal(updateMarkupSelection(original,['one'],{width:3},1,later,unlocked)[1].width,3);
 assert.throws(()=>groupMarkups([mark('one',{layerId:'a'}),mark('two',{layerId:'b'})],['one','two'],'g',1,later,unlocked));
});

test('malformed assignment operations fail without partial changes',()=>{
 const original=marks(),metadata=layers(),before=structuredClone({original,metadata});
 for(const ids of [[],['missing'],['one','one'],new Array(1),[null]])assert.throws(()=>assignMarkupLayer(original,ids,'b',metadata,1,later));
 assert.throws(()=>assignMarkupLayer(original,['one'],'missing',metadata,1,later));
 assert.throws(()=>assignMarkupLayer(original,['one'],'b',metadata,1,'bad-time'));
 assert.throws(()=>removeMarkupLayer(original,metadata,'missing',1,later));
 assert.throws(()=>removeMarkupLayer([],metadata,'empty',1,'bad-time'));
 assert.deepEqual({original,metadata},before);
});
