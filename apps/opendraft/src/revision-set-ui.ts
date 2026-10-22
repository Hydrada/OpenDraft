import {inspectBatchSource, type BatchSource} from './batch-comparison';
import {pairSheets} from './sheet-pairing';
import {validateRevisionPlan, type SavedRevisionPlan} from './revision-plan';
import {runRevisionSet, type RevisionSetJob} from './revision-set';
import {parseRevisionSetPlan, serializeRevisionSetPlan, resolveRevisionSetPlan, REVISION_SET_PLAN_MAX_BYTES} from './revision-set-plan';

type Inspected = {id:string; number:number; source:BatchSource};
type Mapping = {base:Inspected; revisionId:string; pairs:{basePage:number;revisionPage:number}[]};
const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024;
const issue = (error:unknown) => error instanceof Error ? error.message : String(error);
const normalized = (name:string) => name.normalize('NFC').trim().toUpperCase().normalize('NFC');

/** File-set operations use isolated snapshots; no changes enter open workspaces or source files. */
export function mountRevisionSet(): {open():void} {
  const dialog = document.createElement('dialog');
  dialog.className='revision-dialog batch-dialog'; dialog.setAttribute('aria-labelledby','revision-set-title');
  dialog.innerHTML=`<h2 id="revision-set-title">Revise drawing set</h2>
    <p>Select current and revised PDFs or folders. Original files and loaded workspaces remain unchanged; results are downloaded as a ZIP. No automatic disk writes.</p>
    <div class="revision-fields"><fieldset><legend>Current drawings</legend><label>Files<input type="file" multiple accept=".pdf,application/pdf" aria-label="Current drawing files"></label><label>Folder<input type="file" multiple webkitdirectory aria-label="Current drawing folder"></label></fieldset>
    <fieldset><legend>Revision drawings</legend><label>Files<input type="file" multiple accept=".pdf,application/pdf" aria-label="Revision drawing files"></label><label>Folder<input type="file" multiple webkitdirectory aria-label="Revision drawing folder"></label></fieldset>
    <label>Pair sheets by<select aria-label="Drawing set pairing strategy"><option value="label">Unique PDF page labels</option><option value="order">Page order</option></select></label>
    <label>Operation<select aria-label="Drawing set operation"><option value="replace">Replace drawing content</option><option value="insert-before">Insert revision before superseded sheet</option></select></label>
    <label>Revision reason<textarea aria-label="Drawing set reason" maxlength="1000"></textarea></label></div>
    <p>Limits: 20 PDFs per side, 64 MiB per PDF and 256 MiB combined. Non-PDF folder files are ignored and counted. Failed PDF inspections are listed individually.</p>
    <p>Replacement retains source PDF annotations only with matching geometry. Retained PDF annotations, including old measurement labels, may be stale and require visual and engineering review; legacy PDF measurement annotations are not cleared. Insertion retains and stamps old sheets. New drawings require independent calibration. This standalone workflow does not import or edit authored markups or takeoff from loaded workspaces, and never transfers engineering quantities. Review every mapping and exclusion.</p>
    <div class="revision-actions"><button data-action="prepare">Prepare drawing set</button><button data-action="cancel" disabled>Cancel drawing set</button><button data-action="close">Close drawing set</button></div>
    <section aria-label="Drawing set inspection"><ul data-inspections></ul></section>
    <section aria-label="Drawing set review" hidden><h3>Review drawing and sheet pairs</h3><p>Filename suggestions require a unique normalized basename on both sides. Duplicate filenames and duplicate/missing sheet labels remain unmatched. Choose mappings explicitly; zero excludes a sheet.</p><div data-mappings></div><p data-exclusions></p>
    <p>Save mappings to resume with these exact PDFs later. Plans contain no PDFs or approval. Import excludes drawings absent from the plan and requires fresh review.</p>
    <button data-action="save-plan">Save drawing set plan</button><label>Import drawing set plan<input type="file" accept=".json,application/json" aria-label="Import drawing set plan"></label>
    <label><input type="checkbox" aria-label="Approve drawing set impact"> I reviewed these sources, mappings, exclusions and revision impact.</label><button data-action="run" disabled>Apply reviewed drawing set</button></section>
    <p role="status" aria-label="Drawing set status">Select PDFs and prepare a drawing set.</p><p role="alert" aria-label="Drawing set error" hidden></p>
    <section aria-label="Drawing set results" hidden><h3>Drawing set results</h3><ol></ol><button data-action="download">Download revised drawing set ZIP</button><p>Each selected drawing has a success or failure result. The archive includes successful PDFs and JSON/CSV evidence. Cancellation retains no partial ZIP.</p></section>`;
  document.body.append(dialog);
  const find=<T extends Element>(selector:string) => dialog.querySelector<T>(selector)!;
  const field=(name:string) => find<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[aria-label="${name}"]`);
  const button=(action:string) => find<HTMLButtonElement>(`[data-action="${action}"]`);
  const status=find<HTMLElement>('[aria-label="Drawing set status"]'), error=find<HTMLElement>('[aria-label="Drawing set error"]');
  const review=find<HTMLElement>('[aria-label="Drawing set review"]'), results=find<HTMLElement>('[aria-label="Drawing set results"]');
  const approved=field('Approve drawing set impact') as HTMLInputElement;
  let generation=0, controller:AbortController|undefined, saved:Uint8Array|undefined, readingPlan=false;
  let current:Inspected[]=[], revisions:Inspected[]=[], mappings:Mapping[]=[];
  const files=(side:'Current'|'Revision') => ['files','folder'].flatMap(kind=>Array.from((field(`${side} drawing ${kind}`) as HTMLInputElement).files??[]));
  function revoke() { approved.checked=false;button('run').disabled=true;saved=undefined;results.hidden=true;error.hidden=true; }
  function cancel() { generation++;controller?.abort();controller=undefined;readingPlan=false;button('prepare').disabled=false;button('cancel').disabled=true;revoke(); }
  function changed() { cancel();status.textContent='Settings changed. Review and approve the updated drawing set.'; }
  function reset() { cancel();current=[];revisions=[];mappings=[];review.hidden=true;find('[data-mappings]').replaceChildren();find('[data-inspections]').replaceChildren();status.textContent='Files changed. Prepare a new drawing set.'; }
  function selectedJobs():RevisionSetJob[] {
    const reason=field('Drawing set reason').value;
    const operation=field('Drawing set operation').value as SavedRevisionPlan['operation'];
    const createdAt=new Date().toISOString(), jobs:RevisionSetJob[]=[], used=new Set<string>();
    for(const mapping of mappings) {
      if(!mapping.revisionId) continue;
      const revision=revisions.find(item=>item.id===mapping.revisionId);
      if(!revision) throw new Error('Prepare a current revision file mapping.');
      const pairs=mapping.pairs.filter(pair=>pair.revisionPage>0);
      if(!pairs.length) continue;
      if(used.has(revision.id)) throw new Error('A revision file may be assigned to only one current drawing.');
      used.add(revision.id);
      const base=mapping.base.source;
      const plan=validateRevisionPlan({schema:'opendraft.revision-plan',version:1,createdAt,base:{sha256:base.sha256,pageCount:base.pageCount},revision:{sha256:revision.source.sha256,pageCount:revision.source.pageCount},operation,markupPolicy:'retain',reason,pairs});
      jobs.push({id:mapping.base.id,base,revision:revision.source,plan});
    }
    if(!jobs.length) throw new Error('Select at least one drawing with reviewed sheet pairs.');
    return jobs;
  }
  function exclusions() {
    const used=new Set(mappings.filter(mapping=>mapping.revisionId&&mapping.pairs.some(pair=>pair.revisionPage>0)).map(mapping=>mapping.revisionId));
    const missing=mappings.filter(mapping=>!mapping.revisionId||!mapping.pairs.some(pair=>pair.revisionPage>0)).map(mapping=>mapping.base.number);
    const leftover=revisions.filter(item=>!used.has(item.id)).map(item=>item.number);
    find<HTMLElement>('[data-exclusions]').textContent=`Excluded/unmatched current drawings: ${missing.join(', ')||'none'}. Unused revision drawings: ${leftover.join(', ')||'none'}.`;
  }
  function defaultPairs(mapping:Mapping) {
    const revision=revisions.find(item=>item.id===mapping.revisionId);
    const match=revision?pairSheets(mapping.base.source.labels,revision.source.labels,field('Drawing set pairing strategy').value as 'label'|'order'):undefined;
    mapping.pairs=Array.from({length:mapping.base.source.pageCount},(_,i)=>({basePage:i+1,revisionPage:match?.pairs.find(pair=>pair.basePage===i+1)?.revisionPage??0}));
    return match?.warnings??[];
  }
  function renderMappings() {
    const container=find<HTMLElement>('[data-mappings]');container.replaceChildren();
    const allSmall=mappings.reduce((sum,mapping)=>sum+mapping.base.source.pageCount,0)<=400;
    for(const mapping of mappings) {
      const section=document.createElement('section'), heading=document.createElement('h4');
      heading.textContent=`Drawing ${mapping.base.number}: ${mapping.base.source.name}`;section.append(heading);
      const label=document.createElement('label');label.textContent='Revision file ';
      const select=document.createElement('select');select.setAttribute('aria-label',`Revision file for current drawing ${mapping.base.number}`);
      select.add(new Option('Unmatched / excluded',''));
      for(const revision of revisions) select.add(new Option(`${revision.number}: ${revision.source.name}`,revision.id));
      select.value=mapping.revisionId;label.append(select);section.append(label);
      const details=document.createElement('details'), summary=document.createElement('summary');
      summary.textContent=`Sheet pairs for drawing ${mapping.base.number}`;details.append(summary);section.append(details);
      const warnings=document.createElement('p'), body=document.createElement('div');body.className='batch-table';details.append(warnings,body);
      let rendered=false;
      function renderSheets() {
        rendered=true;body.replaceChildren();const revision=revisions.find(item=>item.id===mapping.revisionId);
        if(!revision){warnings.textContent='No revision file selected. Every sheet is excluded.';return;}
        const used=new Set(mapping.pairs.filter(pair=>pair.revisionPage>0).map(pair=>pair.revisionPage));
        const omitted=mapping.pairs.filter(pair=>pair.revisionPage===0).map(pair=>pair.basePage);
        const unused=Array.from({length:revision.source.pageCount},(_,i)=>i+1).filter(page=>!used.has(page));
        warnings.textContent=`Excluded current sheets: ${omitted.join(', ')||'none'}. Unmatched revision sheets: ${unused.join(', ')||'none'}. Duplicate or missing labels are not guessed.`;
        const table=document.createElement('table'), head=document.createElement('thead'), row=document.createElement('tr');
        for(const name of ['Current sheet','Revision sheet']){const th=document.createElement('th');th.textContent=name;row.append(th);}head.append(row);table.append(head);
        const tbody=document.createElement('tbody');
        for(const pair of mapping.pairs){
          const tr=document.createElement('tr'), name=document.createElement('th');name.scope='row';name.textContent=`${pair.basePage} — ${mapping.base.source.labels[pair.basePage-1]??'(no PDF label)'}`;tr.append(name);
          const td=document.createElement('td'), sheet=document.createElement('select');sheet.setAttribute('aria-label',`Revision sheet for drawing ${mapping.base.number} page ${pair.basePage}`);sheet.add(new Option('Excluded','0'));
          for(let page=1;page<=revision.source.pageCount;page++)sheet.add(new Option(`${page} — ${revision.source.labels[page-1]??'(no PDF label)'}`,String(page)));
          sheet.value=String(pair.revisionPage);sheet.onchange=()=>{changed();pair.revisionPage=Number(sheet.value);exclusions();renderSheets();};td.append(sheet);tr.append(td);tbody.append(tr);
        }
        table.append(tbody);body.append(table);
      }
      details.ontoggle=()=>{if(details.open&&!rendered)renderSheets();};
      details.open=allSmall;
      if(allSmall)renderSheets();
      select.onchange=()=>{changed();mapping.revisionId=select.value;const issues=defaultPairs(mapping);rendered=false;warnings.textContent=issues.join(' ');if(details.open)renderSheets();else body.replaceChildren();exclusions();};
      container.append(section);
    }
    exclusions();
  }
  for(const name of ['Current drawing files','Revision drawing files','Current drawing folder','Revision drawing folder'])field(name).addEventListener('change',reset);
  field('Drawing set pairing strategy').addEventListener('change',()=>{changed();for(const mapping of mappings)defaultPairs(mapping);renderMappings();});
  for(const name of ['Drawing set operation','Drawing set reason'])field(name).addEventListener('input',changed);
  approved.onchange=()=>{
    if(controller){approved.checked=false;button('run').disabled=true;if(!readingPlan){cancel();status.textContent='Approval withdrawn. Drawing set cancelled.';}return;}
    saved=undefined;results.hidden=true;error.hidden=true;try{selectedJobs();button('run').disabled=!approved.checked;}catch(e){approved.checked=false;button('run').disabled=true;error.textContent=issue(e);error.hidden=false;}
  };
  button('prepare').onclick=async()=>{
    reset();const run=++generation, signalController=new AbortController();controller=signalController;
    button('prepare').disabled=true;button('cancel').disabled=false;
    const log=find<HTMLElement>('[data-inspections]');
    const line=(text:string)=>{const item=document.createElement('li');item.textContent=text;log.append(item);};
    try{
      const all=[files('Current'),files('Revision')], pdfs=all.map(values=>values.filter(file=>/\.pdf$/iu.test(file.name)));
      const ignored=all.map((values,i)=>values.length-pdfs[i].length);
      line(`Ignored non-PDF files: current ${ignored[0]}, revision ${ignored[1]}.`);
      if(pdfs.some(values=>values.length<1||values.length>20))throw new Error('Choose 1–20 PDF files on each side.');
      if(pdfs.flat().some(file=>file.size<1||file.size>MAX_FILE))throw new Error('Each PDF must contain 1 byte–64 MiB. No PDF bytes were read.');
      if(pdfs.flat().reduce((sum,file)=>sum+file.size,0)>MAX_TOTAL)throw new Error('Drawing set exceeds 256 MiB combined. No PDF bytes were read.');
      const inspected:Inspected[][]=[[],[]];let completed=0,total=pdfs[0].length+pdfs[1].length;
      for(let side=0;side<2;side++)for(let index=0;index<pdfs[side].length;index++){
        const file=pdfs[side][index];if(run!==generation||signalController.signal.aborted)return;
        status.textContent=`Inspecting PDF ${completed+1} of ${total}: ${file.name}`;
        try{
          const bytes=new Uint8Array(await file.arrayBuffer());if(run!==generation||signalController.signal.aborted)return;
          const source=await inspectBatchSource({name:file.name,bytes},signalController.signal);if(run!==generation||signalController.signal.aborted)return;
          inspected[side].push({id:`${side===0?'current':'revision'}-${index+1}`,number:index+1,source});
          line(`${side===0?'Current':'Revision'} drawing ${index+1}: ${file.name} — inspected ${source.pageCount} pages; SHA-256 ${source.sha256}.`);
        }catch(e){if(run!==generation||signalController.signal.aborted)return;line(`${side===0?'Current':'Revision'} drawing ${index+1}: ${file.name} — inspection failed: ${issue(e)}`);}
        completed++;
      }
      if(run!==generation)return;[current,revisions]=inspected;
      if(!current.length||!revisions.length)throw new Error('No successfully inspected PDFs on one side. Review the per-file failures.');
      mappings=current.map(base=>{
        const name=normalized(base.source.name), uniqueCurrent=current.filter(item=>normalized(item.source.name)===name).length===1;
        const candidates=revisions.filter(item=>normalized(item.source.name)===name);
        const mapping={base,revisionId:uniqueCurrent&&candidates.length===1?candidates[0].id:'',pairs:[]};defaultPairs(mapping);return mapping;
      });
      renderMappings();review.hidden=false;status.textContent=`Prepared ${current.length} current and ${revisions.length} revision drawings. Review file and sheet mappings, exclusions and failures before approval.`;
    }catch(e){if(run===generation){error.textContent=issue(e);error.hidden=false;status.textContent='Drawing set preparation did not complete.';}}
    finally{if(run===generation){controller=undefined;button('prepare').disabled=false;button('cancel').disabled=true;}}
  };
  button('save-plan').onclick=()=>{
    if(controller)return;
    try{
      const text=serializeRevisionSetPlan({schema:'opendraft.revision-set-plan',version:1,createdAt:new Date().toISOString(),jobs:selectedJobs().map(job=>job.plan)});
      const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='opendraft-drawing-set-plan.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      error.hidden=true;status.textContent='Drawing set plan saved. Reselect and inspect these exact PDFs to resume; approval is never saved.';
    }catch(e){error.textContent=issue(e);error.hidden=false;}
  };
  const planFile=field('Import drawing set plan') as HTMLInputElement;
  planFile.onchange=async()=>{
    const file=planFile.files?.[0];planFile.value='';if(!file)return;
    cancel();const run=++generation,signalController=new AbortController();controller=signalController;readingPlan=true;
    button('prepare').disabled=true;button('cancel').disabled=false;status.textContent='Reading drawing set plan. Approval is unavailable until import finishes.';
    try{
      if(!current.length||!revisions.length)throw new Error('Prepare the PDF sources before importing a drawing set plan.');
      if(file.size>REVISION_SET_PLAN_MAX_BYTES)throw new Error('Drawing set plan exceeds the 1 MiB UTF-8 limit.');
      const text=await file.text();if(run!==generation||signalController.signal.aborted)return;
      const {plan,matches}=resolveRevisionSetPlan(parseRevisionSetPlan(text),current.map(item=>item.source),revisions.map(item=>item.source));
      const restored:Mapping[]=current.map((base,index)=>{
        const match=matches.find(item=>item.baseIndex===index);
        return {base,revisionId:match?revisions[match.revisionIndex].id:'',pairs:Array.from({length:base.source.pageCount},(_,i)=>({basePage:i+1,revisionPage:match?.pairs.find(pair=>pair.basePage===i+1)?.revisionPage??0}))};
      });
      mappings=restored;field('Drawing set operation').value=plan.jobs[0].operation;field('Drawing set reason').value=plan.jobs[0].reason;
      renderMappings();review.hidden=false;status.textContent='Drawing set plan imported. Review restored mappings, excluded drawings and source impact, then approve again.';
    }catch(e){if(run===generation){error.textContent=issue(e);error.hidden=false;status.textContent='Drawing set plan import failed. Existing mappings and settings retained; review and approve again.';}}
    finally{if(run===generation){controller=undefined;readingPlan=false;button('prepare').disabled=false;button('cancel').disabled=true;}}
  };
  button('run').onclick=async()=>{
    if(!approved.checked||controller)return;
    let jobs:RevisionSetJob[];try{jobs=selectedJobs();}catch(e){revoke();error.textContent=issue(e);error.hidden=false;return;}
    const run=++generation, signalController=new AbortController();controller=signalController;saved=undefined;results.hidden=true;error.hidden=true;
    button('run').disabled=true;button('prepare').disabled=true;button('cancel').disabled=false;
    status.textContent=`Applying reviewed drawing set: 0 of ${jobs.length}.`;
    try{
      const output=await runRevisionSet(jobs,new Date().toISOString(),signalController.signal,(done,total)=>{if(run===generation)status.textContent=`Applying reviewed drawing set: ${done} of ${total}.`;});
      if(run!==generation||signalController.signal.aborted)return;
      saved=output.zip;const list=find<HTMLOListElement>('[aria-label="Drawing set results"] ol');list.replaceChildren();
      let succeeded=0;for(const result of output.manifest.results){const item=document.createElement('li');item.textContent=`${result.id}: ${result.status}${result.error?` — ${result.error}`:''}`;if(result.status==='succeeded')succeeded++;list.append(item);}
      results.hidden=false;status.textContent=`Drawing set finished: ${succeeded} succeeded, ${output.manifest.results.length-succeeded} failed. Original files and loaded workspaces are unchanged.`;
    }catch(e){if(run===generation){saved=undefined;results.hidden=true;error.textContent=issue(e);error.hidden=false;status.textContent='Drawing set failed. No partial ZIP retained.';}}
    finally{if(run===generation){controller=undefined;button('prepare').disabled=false;button('cancel').disabled=true;approved.checked=false;button('run').disabled=true;}}
  };
  button('download').onclick=()=>{if(!saved)return;const url=URL.createObjectURL(new Blob([saved.slice().buffer],{type:'application/zip'})),link=document.createElement('a');link.href=url;link.download='opendraft-revised-drawing-set.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  button('cancel').onclick=()=>{cancel();status.textContent='Drawing set cancelled. No partial ZIP retained.';};
  button('close').onclick=()=>dialog.close();dialog.addEventListener('close',reset);dialog.addEventListener('cancel',cancel);
  return {open(){if(!dialog.open)dialog.showModal();}};
}
