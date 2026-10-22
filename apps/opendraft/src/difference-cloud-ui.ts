import {proposeDifferenceClouds, type CloudGeometry, type CloudOptions, type CloudRegion} from './difference-clouds';
import type {RasterComparison} from './revision-comparison';
import {validateMarkups, type Markup} from './annotations';

export type CloudSource={id:string;bytes:Uint8Array;pageCount:number};
export type CloudSnapshot={pixels:RasterComparison;evidence:Record<string,unknown>;sources:[CloudSource,CloudSource];geometry:CloudGeometry;pageIndex:number;scale:number};
export type CommitDifferenceClouds=(sources:[CloudSource,CloudSource],markups:Markup[])=>Promise<boolean>;

export function mountDifferenceCloudReview(container:HTMLElement,getSnapshot:()=>CloudSnapshot|undefined,getSources:()=>CloudSource[],commit:CommitDifferenceClouds){
  container.innerHTML=`<h3>Difference cloud annotations</h3><p>Propose visual change regions on the base drawing. Raster artifacts, annotation appearances and poor alignment can produce false changes. Clouds do not verify engineering changes or measurements. Changes outside the base page are excluded; overlapping boxes may remain separate.</p>
    <fieldset><legend>Cloud proposal settings</legend><label>Minimum changed pixels<input aria-label="Cloud minimum pixels" type="number" min="1" max="1000000" step="1" value="16"></label><label>Margin (physical points)<input aria-label="Cloud margin points" type="number" min="0" max="36" step="any" value="4"></label><button type="button" data-cloud="propose">Propose difference clouds</button></fieldset>
    <section aria-label="Difference cloud review" hidden><p data-cloud-summary></p><canvas aria-label="Difference cloud preview"></canvas><fieldset><legend>Select regions to add</legend><div data-cloud-regions></div><label><input type="checkbox" aria-label="Approve selected difference clouds"> I reviewed the selected regions, alignment and source drawing.</label><button type="button" data-cloud="apply" disabled>Add selected clouds to base drawing</button></fieldset></section><p role="status" aria-label="Difference cloud status"></p><p role="alert" aria-label="Difference cloud error" hidden></p>`;
  const find=<T extends Element>(selector:string)=>container.querySelector<T>(selector)!;
  const review=find<HTMLElement>('[aria-label="Difference cloud review"]'),preview=find<HTMLCanvasElement>('canvas'),list=find<HTMLElement>('[data-cloud-regions]');
  const approved=find<HTMLInputElement>('[aria-label="Approve selected difference clouds"]'),apply=find<HTMLButtonElement>('[data-cloud="apply"]');
  const status=find<HTMLElement>('[aria-label="Difference cloud status"]'),error=find<HTMLElement>('[aria-label="Difference cloud error"]');
  let proposal:{snapshot:CloudSnapshot;regions:CloudRegion[];options:CloudOptions}|undefined,applying=false;
  const selected=()=>Array.from(list.querySelectorAll<HTMLInputElement>('input:checked')).map(input=>Number(input.value));
  function revoke(){approved.checked=false;apply.disabled=true;error.hidden=true;}
  function invalidate(){proposal=undefined;revoke();review.hidden=true;list.replaceChildren();preview.width=preview.height=0;status.textContent='';}
  function draw(){
    if(!proposal)return;const {pixels}=proposal.snapshot;
    preview.width=pixels.width;preview.height=pixels.height;const ctx=preview.getContext('2d');if(!ctx)throw new Error('Cloud preview canvas unavailable.');
    const image=ctx.createImageData(pixels.width,pixels.height);image.data.set(pixels.difference);ctx.putImageData(image,0,0);
    const ids=new Set(selected());ctx.lineWidth=2;ctx.font='bold 14px sans-serif';
    for(const region of proposal.regions){const {x,y,width,height}=region.rasterBounds;ctx.strokeStyle=ids.has(region.id)?'#008040':'#666666';ctx.fillStyle=ctx.strokeStyle;ctx.strokeRect(x,y,width,height);ctx.fillText(String(region.id),Math.max(0,x+2),Math.max(14,y+14));}
  }
  for(const input of container.querySelectorAll<HTMLInputElement>('input[type="number"]'))input.oninput=()=>{if(!applying)invalidate();};
  find<HTMLButtonElement>('[data-cloud="propose"]').onclick=()=>{
    if(applying)return;invalidate();
    try{
      const snapshot=getSnapshot();if(!snapshot)throw new Error('Compare pages before proposing clouds.');
      const minimum=find<HTMLInputElement>('[aria-label="Cloud minimum pixels"]').value,margin=find<HTMLInputElement>('[aria-label="Cloud margin points"]').value;
      if(!minimum.trim()||!margin.trim()||!Number.isFinite(Number(margin))||Number(margin)<0||Number(margin)>36)throw new Error('Enter minimum changed pixels and a margin from 0 to 36 points.');
      const options={minPixels:Number(minimum),paddingPixels:Number(margin)*snapshot.scale};
      const result=proposeDifferenceClouds(snapshot.pixels,snapshot.geometry,options);
      proposal={snapshot,regions:result.regions,options};
      find<HTMLElement>('[data-cloud-summary]').textContent=`${result.regions.length} proposed regions on the base page; ${result.smallRegions} small regions and ${result.outsideRegions} entirely outside-base regions excluded. Eight-connected pixels form bounding boxes. Select regions individually and approve before adding.`;
      for(const region of result.regions){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=String(region.id);input.setAttribute('aria-label',`Include difference region ${region.id}`);label.append(input,` Region ${region.id}: ${region.changedPixels} changed pixels; PDF bounds ${region.pdfBounds.map(v=>v.toFixed(3)).join(', ')}${region.clipped?' (clipped to base page)':''}`);list.append(label);input.onchange=()=>{revoke();draw();};}
      review.hidden=false;draw();status.textContent=result.regions.length?'Review proposed regions. No annotations added.':'No eligible cloud regions. No annotations added.';
    }catch(e){invalidate();error.textContent=e instanceof Error?e.message:String(e);error.hidden=false;}
  };
  approved.onchange=()=>{apply.disabled=applying||!approved.checked||!proposal||!selected().length;if(!selected().length)approved.checked=false;};
  apply.onclick=async()=>{
    if(applying||!approved.checked||!proposal||proposal.snapshot!==getSnapshot())return;
    const pending=proposal,ids=new Set(selected());if(!ids.size)return;
    try{
      const current=getSources();
      if(pending.snapshot.sources.some(source=>!current.some(item=>item.id===source.id&&item.bytes===source.bytes&&item.pageCount===source.pageCount)))throw new Error('Comparison sources changed or closed. Compare again before adding clouds.');
      const evidence=pending.snapshot.evidence,base=evidence.base as Record<string,unknown>,revision=evidence.revision as Record<string,unknown>;
      const now=new Date().toISOString();
      const marks=validateMarkups(pending.regions.filter(region=>ids.has(region.id)).map(region=>({id:`difference-${crypto.randomUUID()}`,pageIndex:pending.snapshot.pageIndex,kind:'cloud',points:[[region.pdfBounds[0],region.pdfBounds[1]],[region.pdfBounds[2],region.pdfBounds[3]]],color:[0.85,0,0],width:1.5,opacity:1,contents:JSON.stringify({schema:'opendraft.difference-cloud',version:1,reviewedAt:now,scope:'Reviewed raster region, not engineering acceptance.',base:{sha256:base.sha256,page:base.page},revision:{sha256:revision.sha256,page:revision.page},renderer:evidence.renderer,alignment:evidence.alignment,threshold:(evidence.comparison as Record<string,unknown>).threshold,unionOrigin:{x:pending.snapshot.pixels.originX,y:pending.snapshot.pixels.originY},options:pending.options,region}),author:'OpenDraft comparison',status:'open',locked:false,createdAt:now,modifiedAt:now})),pending.snapshot.sources[0].pageCount);
      applying=true;for(const fieldset of container.querySelectorAll('fieldset'))fieldset.disabled=true;apply.disabled=true;
      if(!await commit(pending.snapshot.sources,marks))throw new Error('Cloud annotations were not committed. Sources may have changed or be busy. Compare and review again.');
      invalidate();status.textContent=`Added ${marks.length} reviewed cloud annotations to the base drawing as one undoable edit. Measurements were unchanged. Compare again before adding more.`;
    }catch(e){revoke();error.textContent=e instanceof Error?e.message:String(e);error.hidden=false;}
    finally{applying=false;for(const fieldset of container.querySelectorAll('fieldset'))fieldset.disabled=false;}
  };
  return {invalidate};
}
