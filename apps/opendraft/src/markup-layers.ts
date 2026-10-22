import {validateMarkups, type Markup} from './annotations.ts';

export type MarkupLayer = {id:string; name:string; visible:boolean; locked:boolean};

/** Canonical bounded layer metadata; no source-PDF layer objects or scripts are accepted. */
export function validateMarkupLayers(value:unknown):MarkupLayer[] {
  if(!Array.isArray(value)||value.length>256) throw new Error('Markup layers must be an array of at most 256 entries.');
  const ids=new Set<string>(),names=new Set<string>();
  return Array.from(value,(item:unknown):MarkupLayer=>{
    if(!item||typeof item!=='object'||Array.isArray(item)) throw new Error('Invalid markup layer.');
    const layer=item as Record<string,unknown>;
    if(typeof layer.id!=='string'||!/^[a-zA-Z0-9._:-]{1,120}$/.test(layer.id)) throw new Error('Invalid markup layer id.');
    if(typeof layer.name!=='string') throw new Error('Invalid markup layer name.');
    const name=layer.name.trim().normalize('NFC');
    if(!name||name.length>80||/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Layer name must contain 1–80 characters without control characters.');
    if(typeof layer.visible!=='boolean'||typeof layer.locked!=='boolean') throw new Error('Layer visibility and edit lock must be true or false.');
    const key=name.toLowerCase();
    if(ids.has(layer.id)||names.has(key)) throw new Error('Duplicate markup layer id or name.');
    ids.add(layer.id);names.add(key);
    return {id:layer.id,name,visible:layer.visible,locked:layer.locked};
  });
}

/** Validate all membership references and return defensive canonical annotation copies. */
export function validateLayerAssignments(marks:readonly Markup[],layers:readonly MarkupLayer[],pageCount:number):Markup[] {
  const canonical=validateMarkups(marks,pageCount),metadata=validateMarkupLayers(layers),ids=new Set(metadata.map(layer=>layer.id));
  const groupLayers=new Map<string,string|undefined>();
  for(const mark of canonical){
    if(mark.layerId!==undefined&&!ids.has(mark.layerId)) throw new Error('Markup refers to a missing annotation layer.');
    if(mark.groupId!==undefined){
      if(groupLayers.has(mark.groupId)&&groupLayers.get(mark.groupId)!==mark.layerId) throw new Error('Every group member must remain on the same annotation layer.');
      groupLayers.set(mark.groupId,mark.layerId);
    }
  }
  return canonical;
}
function validTimestamp(value:string):void {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value||Number(value.slice(0,4))<1)
    throw new Error('Invalid layer operation timestamp.');
}
function selected(marks:readonly Markup[],ids:readonly string[],layers:readonly MarkupLayer[],pageCount:number):{marks:Markup[];ids:Set<string>;layers:MarkupLayer[]} {
  const canonical=validateLayerAssignments(marks,layers,pageCount),metadata=validateMarkupLayers(layers);
  if(!Array.isArray(ids)||!ids.length||Array.from(ids).some(id=>typeof id!=='string')||new Set(ids).size!==ids.length) throw new Error('Select distinct markup ids.');
  const chosen=new Set(ids),known=new Set(canonical.map(mark=>mark.id));
  if(ids.some(id=>!known.has(id))) throw new Error('Selected markup no longer exists.');
  const groups=new Set(canonical.filter(mark=>chosen.has(mark.id)&&mark.groupId!==undefined).map(mark=>mark.groupId));
  for(const mark of canonical) if(mark.groupId!==undefined&&groups.has(mark.groupId)) chosen.add(mark.id);
  const locked=new Set(metadata.filter(layer=>layer.locked).map(layer=>layer.id));
  for(const mark of canonical) if(chosen.has(mark.id)){
    if(mark.locked) throw new Error('Unlock all selected annotations before changing layer assignments.');
    if(mark.layerId!==undefined&&locked.has(mark.layerId)) throw new Error('Unlock the annotation layer before changing its members.');
  }
  return {marks:canonical,ids:chosen,layers:metadata};
}

/** Assign complete groups atomically; undefined moves selected annotations to the unlayered set. */
export function assignMarkupLayer(marks:readonly Markup[],ids:readonly string[],layerId:string|undefined,layers:readonly MarkupLayer[],pageCount:number,timestamp:string):Markup[] {
  validTimestamp(timestamp);
  const state=selected(marks,ids,layers,pageCount);
  if(layerId!==undefined){
    const target=state.layers.find(layer=>layer.id===layerId);
    if(!target) throw new Error('Target annotation layer does not exist.');
    if(target.locked) throw new Error('Unlock the target annotation layer before assigning annotations.');
  }
  return validateLayerAssignments(state.marks.map(mark=>{
    if(!state.ids.has(mark.id))return mark;
    const {layerId:previous,...rest}=mark;
    return {...rest,...(layerId!==undefined?{layerId}:{}),modifiedAt:timestamp};
  }),state.layers,pageCount);
}

/** Remove layer metadata and clear memberships, retaining every annotation and group. */
export function removeMarkupLayer(marks:readonly Markup[],layers:readonly MarkupLayer[],id:string,pageCount:number,timestamp:string):{markups:Markup[];layers:MarkupLayer[]} {
  validTimestamp(timestamp);
  const canonical=validateLayerAssignments(marks,layers,pageCount),metadata=validateMarkupLayers(layers),target=metadata.find(layer=>layer.id===id);
  if(!target) throw new Error('Annotation layer no longer exists.');
  if(target.locked) throw new Error('Unlock the annotation layer before removing it.');
  if(canonical.some(mark=>mark.layerId===id&&mark.locked)) throw new Error('Unlock all layer annotations before removing the layer.');
  const remaining=metadata.filter(layer=>layer.id!==id);
  const markups=validateLayerAssignments(canonical.map(mark=>{
    if(mark.layerId!==id)return mark;
    const {layerId,...rest}=mark;return {...rest,modifiedAt:timestamp};
  }),remaining,pageCount);
  return {markups,layers:remaining};
}
