import { validateMarkupLayers, assignMarkupLayer, removeMarkupLayer, type MarkupLayer } from './markup-layers';
import type {Markup} from './annotations';
type State={markups:Markup[];layers:MarkupLayer[];pageCount:number;busy:boolean};
type Callbacks={getState:()=>State|undefined;selection:()=>string[];commit:(marks:Markup[],layers:MarkupLayer[])=>Promise<void>;error:(message:string)=>void};
/** Authored layer controls persist state; source layer navigation remains a separate view-only workflow. */
export class MarkupLayerTools {
 private select=document.createElement('select');
 private name=document.createElement('input');
 private visible=document.createElement('input');
 private locked=document.createElement('input');
 private section=document.createElement('section');
 private status=document.createElement('p');
 private signature='';
 private loadedSelection='';
 constructor(container:HTMLElement,private callbacks:Callbacks){
  this.section.setAttribute('aria-label','Authored annotation layers');
  const title=document.createElement('h4');title.textContent='Annotation layers';
  const help=document.createElement('p');help.textContent='Choose a layer for new annotations, or assign the markup selection. Visibility is saved in exported PDFs. Edit locks block annotation changes; hiding a layer is not redaction.';
  this.section.append(title,help);
  const label=(name:string,control:HTMLElement)=>{const row=document.createElement('label');row.textContent=name;control.setAttribute('aria-label',name);row.append(control);this.section.append(row);};
  label('Annotation layer',this.select);label('Layer name',this.name);this.name.maxLength=80;
  this.visible.type='checkbox';this.visible.checked=true;label('Layer visible',this.visible);
  this.locked.type='checkbox';label('Layer edit locked',this.locked);
  this.select.onchange=()=>this.loadFields();
  const button=(name:string,action:(state:State)=>Promise<void>)=>{const b=document.createElement('button');b.textContent=name;b.onclick=()=>void this.run(action);this.section.append(b);};
  button('Create annotation layer',async s=>{
   const layer={id:crypto.randomUUID(),name:this.name.value,visible:this.visible.checked,locked:this.locked.checked};
   const layers=validateMarkupLayers([...s.layers,layer]);await this.callbacks.commit(s.markups,layers);this.choose(layer.id);this.status.textContent='Annotation layer created.';
  });
  button('Update annotation layer',async s=>{
   const selected=s.layers.find(layer=>layer.id===this.layerId);if(!selected)throw new Error('Choose an authored layer first.');
   if(selected.locked&&selected.name!==this.name.value.trim().normalize('NFC'))throw new Error('Unlock the layer before renaming it.');
   const layers=validateMarkupLayers(s.layers.map(layer=>layer.id===selected.id?{...layer,name:this.name.value,visible:this.visible.checked,locked:this.locked.checked}:layer));
   await this.callbacks.commit(s.markups,layers);this.loadFields();this.status.textContent='Annotation layer updated.';
  });
  button('Assign selection to layer',async s=>{
   const marks=assignMarkupLayer(s.markups,this.callbacks.selection(),this.layerId,s.layers,s.pageCount,new Date().toISOString());
   await this.callbacks.commit(marks,s.layers);this.status.textContent='Complete markup selection assigned to the layer.';
  });
  button('Remove layer keeping markups',async s=>{
   if(!this.layerId)throw new Error('Choose an authored layer first.');
   const next=removeMarkupLayer(s.markups,s.layers,this.layerId,s.pageCount,new Date().toISOString());
   await this.callbacks.commit(next.markups,next.layers);this.choose(undefined);this.status.textContent='Layer removed; annotations retained without a layer.';
  });
  this.status.setAttribute('role','status');this.section.append(this.status);container.append(this.section);this.refresh();
 }
 get layerId(){return this.select.value||undefined;}
 choose(id:string|undefined){this.select.value=id??'';this.loadFields();}
 private loadFields(){
  const layer=this.callbacks.getState()?.layers.find(layer=>layer.id===this.layerId);
  this.name.value=layer?.name??'';this.visible.checked=layer?.visible??true;this.locked.checked=layer?.locked??false;
  this.loadedSelection=this.select.value;
 }
 refresh(){
  const state=this.callbacks.getState(),layers=state?.layers??[],signature=JSON.stringify(layers),selected=this.select.value;
  if(signature!==this.signature||!this.select.options.length){
   this.signature=signature;this.select.replaceChildren();
   const none=document.createElement('option');none.value='';none.textContent='Unlayered annotations';this.select.append(none);
   for(const layer of layers){const option=document.createElement('option');option.value=layer.id;option.textContent=`${layer.name}${layer.visible?'':' (hidden)'}${layer.locked?' (edit locked)':''}`;this.select.append(option);}
   this.select.value=layers.some(layer=>layer.id===selected)?selected:'';this.loadFields();
  }else if(this.loadedSelection!==this.select.value)this.loadFields();
  for(const control of this.section.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select'))control.disabled=!state||state.busy;
 }
 private async run(action:(state:State)=>Promise<void>){
  try{const state=this.callbacks.getState();if(!state||state.busy)return;await action(state);this.refresh();}
  catch(error){this.callbacks.error(error instanceof Error?error.message:String(error));}
 }
}
