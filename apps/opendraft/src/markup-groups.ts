import {type Markup} from './annotations.ts';
import {validateLayerAssignments, validateMarkupLayers, type MarkupLayer} from './markup-layers.ts';

export type MarkupSelectionPatch = Partial<Pick<Markup, 'color' | 'width' | 'opacity' | 'status'>>;
type Selection = {marks:Markup[]; ids:Set<string>; layers:MarkupLayer[]};
function selection(marks:readonly Markup[], ids:readonly string[], pageCount:number, allowLocked=false, layers:readonly MarkupLayer[]=[]):Selection {
  const metadata=validateMarkupLayers(layers),canonical=validateLayerAssignments(marks,metadata,pageCount);
  if (!Array.isArray(ids) || !ids.length || Array.from(ids).some(id=>typeof id!=='string') || new Set(ids).size!==ids.length)
    throw new Error('Select distinct markup ids.');
  const chosen=new Set(ids), known=new Set(canonical.map(mark=>mark.id));
  if(ids.some(id=>!known.has(id))) throw new Error('Selected markup no longer exists.');
  const groups=new Set(canonical.filter(mark=>chosen.has(mark.id)&&mark.groupId!==undefined).map(mark=>mark.groupId!));
  for(const mark of canonical) if(mark.groupId!==undefined&&groups.has(mark.groupId)) chosen.add(mark.id);
  if(!allowLocked&&canonical.some(mark=>chosen.has(mark.id)&&mark.locked))
    throw new Error('Unlock all selected group members before changing them.');
  const lockedLayers=new Set(metadata.filter(layer=>layer.locked).map(layer=>layer.id));
  if(canonical.some(mark=>chosen.has(mark.id)&&mark.layerId!==undefined&&lockedLayers.has(mark.layerId)))
    throw new Error('Unlock the annotation layer before changing its members.');
  return {marks:canonical,ids:chosen,layers:metadata};
}
function changed(selection:Selection, pageCount:number, timestamp:string, change:(mark:Markup)=>Markup):Markup[] {
  return validateLayerAssignments(selection.marks.map(mark=>selection.ids.has(mark.id)?{...change(mark),modifiedAt:timestamp}:mark),selection.layers,pageCount);
}
/** All actions include entire existing groups; returned data is defensively copied and validated atomically. */
export function groupMarkups(marks:readonly Markup[], ids:readonly string[], groupId:string, pageCount:number, timestamp:string, layers:readonly MarkupLayer[]=[]):Markup[] {
  const chosen=selection(marks,ids,pageCount,false,layers);
  if(typeof groupId!=='string'||!/^[a-zA-Z0-9._:-]{1,120}$/.test(groupId)) throw new Error('Invalid markup group id.');
  const members=chosen.marks.filter(mark=>chosen.ids.has(mark.id));
  if(members.length<2) throw new Error('A group requires at least two selected markups.');
  if(new Set(members.map(mark=>mark.pageIndex)).size!==1) throw new Error('A group must remain on one page.');
  if(chosen.marks.some(mark=>mark.groupId===groupId&&!chosen.ids.has(mark.id))) throw new Error('Group id already belongs to other markups.');
  return changed(chosen,pageCount,timestamp,mark=>({...mark,groupId}));
}
export function ungroupMarkups(marks:readonly Markup[], ids:readonly string[], pageCount:number, timestamp:string, layers:readonly MarkupLayer[]=[]):Markup[] {
  const chosen=selection(marks,ids,pageCount,false,layers);
  if(!chosen.marks.some(mark=>chosen.ids.has(mark.id)&&mark.groupId!==undefined)) throw new Error('Selected markups do not belong to a group.');
  return changed(chosen,pageCount,timestamp,mark=>{const {groupId,...ungrouped}=mark;return ungrouped;});
}
export function updateMarkupSelection(marks:readonly Markup[], ids:readonly string[], patch:MarkupSelectionPatch, pageCount:number, timestamp:string, layers:readonly MarkupLayer[]=[]):Markup[] {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!['color','width','opacity','status'].includes(key))||Object.getOwnPropertySymbols(patch).length)
    throw new Error('Group properties support only color, width, opacity and status.');
  const chosen=selection(marks,ids,pageCount,false,layers);
  return changed(chosen,pageCount,timestamp,mark=>({...mark,...patch}));
}
export function lockMarkupSelection(marks:readonly Markup[], ids:readonly string[], locked:boolean, pageCount:number, timestamp:string, layers:readonly MarkupLayer[]=[]):Markup[] {
  if(typeof locked!=='boolean') throw new Error('Lock state must be true or false.');
  const chosen=selection(marks,ids,pageCount,!locked,layers);
  return changed(chosen,pageCount,timestamp,mark=>({...mark,locked}));
}
export function translateMarkupSelection(marks:readonly Markup[], ids:readonly string[], dx:number, dy:number, pageCount:number, timestamp:string, layers:readonly MarkupLayer[]=[]):Markup[] {
  if(!Number.isFinite(dx)||!Number.isFinite(dy)) throw new Error('Move offsets must be finite.');
  const chosen=selection(marks,ids,pageCount,false,layers);
  const move=([x,y]:[number,number]):[number,number]=>[x+dx,y+dy];
  return changed(chosen,pageCount,timestamp,mark=>({...mark,points:mark.points.map(move),...(mark.callout?{callout:mark.callout.map(move)}:{})}));
}
export function deleteMarkupSelection(marks:readonly Markup[], ids:readonly string[], pageCount:number, layers:readonly MarkupLayer[]=[]):Markup[] {
  const chosen=selection(marks,ids,pageCount,false,layers);
  return validateLayerAssignments(chosen.marks.filter(mark=>!chosen.ids.has(mark.id)),chosen.layers,pageCount);
}
