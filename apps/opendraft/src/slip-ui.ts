import { pdfResources } from './pdf-resources';
import * as pdfjs from 'pdfjs-dist';
import {assertEditablePdf} from './document-safety';
import {inspectBatchSource, type BatchSource} from './batch-comparison';
import {pairSheets, validateSheetPairs, type SheetPair} from './sheet-pairing';
import type {PageRef} from './organization';
import type {Markup} from './annotations';
import type {MarkupLayer} from './markup-layers';
import type {TakeoffState} from './takeoff';
import type {RevisionEntry} from './revision-journal';
import {buildRevisionInsertion} from './revision-insert';
import {parseRevisionPlan, serializeRevisionPlan, assertRevisionPlanSources, type SavedRevisionPlan} from './revision-plan';

export type SlipDocument = {id: string; name: string; bytes: Uint8Array; pages: PageRef[]; markups: Markup[]; takeoff: TakeoffState; layers: MarkupLayer[]; revisions: RevisionEntry[]; busy: boolean};
export type SlipCommit = {expected: SlipDocument; sourceId: string; sourceBytes: Uint8Array; pages: PageRef[]; markups: Markup[]; takeoff: TakeoffState; entry: RevisionEntry};
export const slipStateKey = (source: SlipDocument) => JSON.stringify([source.pages, source.markups, source.takeoff, source.layers, source.revisions]);
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), b => b.toString(16).padStart(2, '0')).join('');
function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {type: 'application/json'})), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reviewed content-only replacement; source objects remain immutable for undo/recovery. */
export function mountSlipReview(getDocuments: () => SlipDocument[], getActiveId: () => string, commit: (change: SlipCommit) => Promise<boolean>) {
  const dialog = document.createElement('dialog'); dialog.className = 'revision-dialog'; dialog.setAttribute('aria-labelledby', 'slip-title');
  dialog.innerHTML = `<h2 id="slip-title">Replace revised sheets</h2><p>Replace drawing content in the current document. Existing target page objects, source PDF annotations and document navigation are retained. Revision PDF annotations, forms and document structures are not imported.</p>
    <label>Revision operation<select aria-label="Slip operation"><option value="replace">Replace current drawing content</option><option value="insert-before">Insert revision before old sheet and stamp old sheet superseded</option></select></label><p data-mode></p>
    <label>Revision PDF<select aria-label="Slip revision document"></select></label><label>Pair by<select aria-label="Slip pairing strategy"><option value="label">Unique PDF page labels</option><option value="order">Page order</option></select></label>
    <label>Authored markups on replaced pages<select aria-label="Slip markup policy"><option value="retain">Retain at existing coordinates (matching geometry required)</option><option value="remove">Remove authored markups on replaced pages</option></select></label>
    <label>Revision reason<input aria-label="Slip revision reason" maxlength="1000" placeholder="Revision identifier and reason"></label>
    <div class="revision-actions"><button data-slip="prepare">Prepare replacement review</button><button data-slip="close">Close replacement review</button></div>
    <div class="revision-actions"><button data-slip="save-plan">Save revision plan JSON</button><label>Import revision plan JSON<input type="file" accept=".json,application/json" aria-label="Import revision plan JSON"></label></div><p>Plans contain source fingerprints and sheet mappings. Import requires the same PDFs and a fresh impact approval.</p>
    <section aria-label="Slip replacement review" hidden><h3>Review replacements and impact</h3><p data-warning></p><div class="batch-table"><table><thead><tr><th>Current sheet</th><th>Revised sheet (0 = unchanged)</th></tr></thead><tbody></tbody></table></div>
    <p data-impact></p><p>Calibration and measurements on every replaced page will be removed. Recalibrate and independently verify the new drawing before takeoff. Retained markups and source PDF annotations require visual review, even when page geometry matches. Original sources remain available for undo and opt-in recovery.</p>
    <label><input type="checkbox" aria-label="Approve sheet replacement impact"> I reviewed the pairs, annotation policy and removal of calibration and measurements.</label><button data-slip="apply" disabled>Apply reviewed replacements</button></section>
    <p role="status" aria-label="Slip status">Prepare a replacement plan.</p><p role="alert" aria-label="Slip error" hidden></p>
    <section aria-label="Revision journal"><h3>Revision journal</h3><p>Local operation evidence, not a tamper-proof audit. Page numbers describe each operation at that time.</p><ol></ol><button data-slip="journal">Export revision journal JSON</button></section>`;
  document.body.append(dialog);
  const find = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  const field = (name: string) => find<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`);
  const button = (name: string) => find<HTMLButtonElement>(`[data-slip="${name}"]`);
  const select = field('Slip revision document') as HTMLSelectElement, approved = field('Approve sheet replacement impact') as HTMLInputElement;
  const status = find<HTMLElement>('[aria-label="Slip status"]'), error = find<HTMLElement>('[aria-label="Slip error"]'), review = find<HTMLElement>('[aria-label="Slip replacement review"]');
  let targetId = '', generation = 0, applying = false, preparing = false, importing = false;
  const inserting = () => field('Slip operation').value === 'insert-before';
  function modeText() {
    find<HTMLElement>('[data-mode]').textContent = inserting() ? 'Inserted revisions contain drawing content only. Old sheets and their markups remain; old sheets receive a visible SUPERSEDED stamp. Existing bookmarks and links continue to target the old sheets. Selected old-sheet calibrations and measurements are removed; new sheets require independent calibration.' : 'Replacement retains existing target page objects and navigation. Donor annotations and forms are excluded.';
    field('Slip markup policy').disabled = inserting();
  }
  let plan: {target: SlipDocument; donor: BatchSource; baseHash: string; pairs: SheetPair[]} | undefined;
  const target = () => getDocuments().find(d => d.id === targetId);
  const issue = (e: unknown) => e instanceof Error ? e.message : String(e);
  function revoke() { approved.checked = false; button('apply').disabled = true; error.hidden = true; }
  function reset() { generation++; revoke(); plan = undefined; review.hidden = true; button('prepare').disabled = false; }
  function journal() {
    const list = find<HTMLOListElement>('[aria-label="Revision journal"] ol'); list.replaceChildren();
    for (const entry of target()?.revisions ?? []) { const li = document.createElement('li'); li.textContent = `${entry.createdAt} — ${entry.reason} (${entry.operation ?? 'replace'}): ${entry.replacements.map(p => `${p.targetPage} ← ${p.revisionPage}`).join(', ')}; ${entry.markupPolicy}; cleared ${entry.clearedMeasurements} measurements and ${entry.clearedScales} scales.`; list.append(li); }
    button('journal').disabled = !target()?.revisions.length;
  }
  function impact() {
    if (!plan) return;
    const replaced = new Set(plan.pairs.filter(p => p.revisionPage > 0).map(p => p.basePage - 1));
    const measures = plan.target.takeoff.records.filter(r => replaced.has(r.pageIndex)).length, scales = plan.target.takeoff.scales.filter(r => replaced.has(r.pageIndex)).length;
    const marks = plan.target.markups.filter(m => replaced.has(m.pageIndex)).length;
    find<HTMLElement>('[data-impact]').textContent = `${replaced.size} ${inserting() ? 'insertions before superseded sheets' : 'replacements'}; ${marks} authored markups affected; ${measures} measurements and ${scales} scale calibrations will be removed. ${plan.target.pages.length - replaced.size} current pages unchanged. Revision pages not selected are not inserted. ${inserting() ? 'Existing markups stay on old sheets; inserted sheets receive no transferred calibration or quantities.' : ''}`;
  }
  select.onchange = reset; field('Slip pairing strategy').onchange = reset;
  field('Slip operation').onchange = () => { reset(); modeText(); };
  const changedSettings = () => { revoke(); if (preparing || importing) generation++; };
  field('Slip markup policy').onchange = changedSettings; field('Slip revision reason').addEventListener('input', changedSettings);
  approved.onchange = () => { if(preparing || importing) approved.checked=false; button('apply').disabled = !approved.checked || applying || preparing || importing; };
  button('close').onclick = () => { if (!applying) dialog.close(); }; dialog.onclose = reset;
  dialog.addEventListener('cancel', event => { if (applying) event.preventDefault(); else reset(); });
  button('journal').onclick = () => download(new TextEncoder().encode(JSON.stringify({schema: 'opendraft.revision-journal', version: 1, entries: target()?.revisions ?? []}, null, 2)), 'opendraft-revision-journal.json');
  async function prepare(saved?: SavedRevisionPlan) {
    if (preparing || applying || (importing && !saved)) return;
    if (saved) { generation++; revoke(); } else reset();
    const token = generation, current = target(), donor = getDocuments().find(d => d.id === select.value);
    preparing = true;
    button('prepare').disabled = true; status.textContent = 'Preparing source and geometry evidence…';
    try {
      if (!current || !donor || current.busy || donor.busy) throw new Error('Select available current and revision documents.');
      const bytes = donor.bytes.slice(), baseBytes = current.bytes.slice();
      await assertEditablePdf(baseBytes); await assertEditablePdf(bytes);
      const base = await inspectBatchSource({name: current.name, bytes: baseBytes}), revision = await inspectBatchSource({name: donor.name, bytes});
      if (saved) assertRevisionPlanSources(saved,base,revision);
      const pairing = saved ? {pairs:saved.pairs.map(p => ({...p,id:`slip-${p.basePage}`,reason:'manual' as const,scale:1,rotationDegrees:0,offsetX:0,offsetY:0})),warnings:['Imported mappings require fresh impact approval.']} : pairSheets(base.labels, revision.labels, field('Slip pairing strategy').value as 'order' | 'label');
      const mapped = new Map(pairing.pairs.map(p => [p.basePage, p]));
      const pairs: SheetPair[] = Array.from({length: current.pages.length}, (_, i) => mapped.get(i + 1) ?? {id: `slip-${i + 1}`, basePage: i + 1, revisionPage: 0, reason: 'manual', scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0});
      // Geometry must be reviewed again after any page mapping change.
      if (token !== generation) return;
      const latest = target();
      if (!latest || latest.bytes !== current.bytes || slipStateKey(latest) !== slipStateKey(current)) throw new Error('Current document changed while preparing. Prepare a new plan.');
      if (saved) { field('Slip operation').value=saved.operation; field('Slip markup policy').value=saved.markupPolicy; field('Slip revision reason').value=saved.reason; modeText(); }
      revoke();
      plan = {target: current, donor: revision, baseHash: base.sha256, pairs};
      const body = find<HTMLTableSectionElement>('tbody'); body.replaceChildren();
      for (const pair of pairs) {
        const row = document.createElement('tr'), name = document.createElement('th'), cell = document.createElement('td'), choice = document.createElement('select');
        name.scope = 'row'; name.textContent = `${pair.basePage}${base.labels[pair.basePage - 1] ? ` — ${base.labels[pair.basePage - 1]}` : ''}`;
        choice.setAttribute('aria-label', `Replace current page ${pair.basePage} with`); choice.add(new Option('0 — unchanged', '0'));
        for (let n = 1; n <= revision.pageCount; n++) choice.add(new Option(`${n}${revision.labels[n - 1] ? ` — ${revision.labels[n - 1]}` : ''}`, String(n)));
        choice.value = String(pair.revisionPage); choice.onchange = () => { changedSettings(); pair.revisionPage = Number(choice.value); pair.reason = 'manual'; impact(); };
        cell.append(choice); row.append(name, cell); body.append(row);
      }
      find<HTMLElement>('[data-warning]').textContent = pairing.warnings.join(' '); impact(); review.hidden = false; status.textContent = saved ? 'Saved revision plan loaded. Review the current impact and approve again.' : 'Review replacement impact. Geometry is checked again before commit.';
    } catch (e) { if (token === generation) { error.textContent = issue(e); error.hidden = false; status.textContent = 'Replacement plan unavailable.'; } }
    finally { preparing=false; button('prepare').disabled = false; }
  }
  button('prepare').onclick = () => { void prepare(); };
  button('save-plan').onclick = async () => {
    if (applying || preparing || importing) return;
    try {
      const current=target(), captured=plan;
      if (!current || !captured || current.bytes!==captured.target.bytes || slipStateKey(current)!==slipStateKey(captured.target)) throw new Error('Prepare a current revision plan before saving.');
      const selected=validateSheetPairs(captured.pairs.filter(p=>p.revisionPage>0),current.pages.length,captured.donor.pageCount);
      const text=serializeRevisionPlan({schema:'opendraft.revision-plan',version:1,createdAt:new Date().toISOString(),base:{sha256:captured.baseHash,pageCount:current.pages.length},revision:{sha256:captured.donor.sha256,pageCount:captured.donor.pageCount},operation:inserting()?'insert-before':'replace',markupPolicy:inserting()?'retain':field('Slip markup policy').value,reason:field('Slip revision reason').value.trim(),pairs:selected.map(({basePage,revisionPage})=>({basePage,revisionPage}))});
      download(new TextEncoder().encode(text),'opendraft-revision-plan.json'); status.textContent='Revision plan saved. Approval is not stored.';
    } catch(e) { error.textContent=issue(e); error.hidden=false; }
  };
  const importPlan=find<HTMLInputElement>('[aria-label="Import revision plan JSON"]');
  importPlan.onchange = async () => {
    const file=importPlan.files?.[0]; importPlan.value='';
    if (!file || applying || preparing || importing) return;
    importing=true; status.textContent='Reading revision plan…'; revoke(); const token=++generation;
    try {
      if (file.size>256*1024) throw new Error('Revision plan exceeds the 256 KiB limit.');
      const saved=parseRevisionPlan(await file.text());
      if (token!==generation) return;
      await prepare(saved);
    } catch(e) { if(token===generation) {revoke();error.textContent=issue(e);error.hidden=false;status.textContent='Revision plan import rejected; current document and mappings unchanged.';} }
    finally { importing=false; }
  };
  button('apply').onclick = async () => {
    if (!plan || !approved.checked || applying || preparing || importing) return;
    const captured = plan, current = target(), token = generation;
    const tasks: ReturnType<typeof pdfjs.getDocument>[] = [];
    applying = true; dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(c => c.disabled = true);
    try {
      const reason = field('Slip revision reason').value.trim(), insertion = inserting(), policy = insertion ? 'retain' : field('Slip markup policy').value as 'retain' | 'remove';
      if (!reason || reason.length > 1000) throw new Error('Enter a revision reason before replacing sheets.');
      if (!current || current.busy || current.bytes !== captured.target.bytes || slipStateKey(current) !== slipStateKey(captured.target)) throw new Error('Current document changed after review. Prepare a new plan.');
      const pairs = validateSheetPairs(captured.pairs.filter(p => p.revisionPage > 0), current.pages.length, captured.donor.pageCount);
      const selected = new Set(pairs.map(p => p.basePage - 1));
      if (policy === 'remove') {
        const locked = new Set(current.layers.filter(l => l.locked).map(l => l.id));
        if (current.markups.some(m => selected.has(m.pageIndex) && (m.locked || (m.layerId && locked.has(m.layerId))))) throw new Error('Unlock affected authored markups and layers before removing them.');
      }
      const stamps: Markup[] = [];
      if (policy === 'retain') {
        const a = pdfjs.getDocument({ ...pdfResources, data: current.bytes.slice()}), b = pdfjs.getDocument({ ...pdfResources, data: captured.donor.bytes.slice()}); tasks.push(a, b);
        const [base, revision] = await Promise.all([a.promise, b.promise]);
        for (const pair of pairs) {
          const [old, next] = await Promise.all([base.getPage(pair.basePage), revision.getPage(pair.revisionPage)]);
          const rotation = ((next.rotate + current.pages[pair.basePage - 1].rotation) % 360 + 360) % 360;
          if (insertion) {
            const [left,bottom,right,top] = old.view, w = right-left, h = top-bottom;
            const stampWidth = Math.min(240,w*0.8), stampHeight = Math.min(60,h*0.25);
            if (stampWidth < 90 || stampHeight < 28) throw new Error(`Page ${pair.basePage} is too small for a readable superseded stamp.`);
            const now = new Date().toISOString();
            stamps.push({id:crypto.randomUUID(),pageIndex:pair.basePage-1,kind:'stamp',stampName:'Draft',points:[[left+(w-stampWidth)/2,bottom+(h-stampHeight)/2],[left+(w+stampWidth)/2,bottom+(h+stampHeight)/2]],color:[0.85,0,0],width:2,opacity:0.8,contents:'SUPERSEDED',author:'OpenDraft',status:'open',locked:false,createdAt:now,modifiedAt:now});
            continue;
          }
          if (JSON.stringify([old.view, old.userUnit, old.rotate]) !== JSON.stringify([next.view, next.userUnit, rotation])) throw new Error(`Page ${pair.basePage} geometry differs. Remove authored markups or choose matching revision geometry; source PDF annotations still retain fixed coordinates.`);
        }
      }
      if (token !== generation || !approved.checked) throw new Error('Replacement approval expired.');
      const sourceId = `revision:${crypto.randomUUID()}`;
      let pages = structuredClone(current.pages);
      for (const pair of pairs) pages[pair.basePage - 1].replacement = {sourceId, pageIndex: pair.revisionPage - 1};
      let takeoff = {scales: current.takeoff.scales.filter(s => !selected.has(s.pageIndex)), records: current.takeoff.records.filter(r => !selected.has(r.pageIndex))};
      let markups = policy === 'retain' ? current.markups : current.markups.filter(m => !selected.has(m.pageIndex));
      if (insertion) ({pages,markups,takeoff} = buildRevisionInsertion(current,pairs,sourceId,captured.donor.labels,stamps));
      const entry: RevisionEntry = {id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...(insertion ? {operation:'insert-before' as const} : {}), reason, baseSha256: captured.baseHash, revisionSha256: captured.donor.sha256, replacements: pairs.map(p => ({targetPage: p.basePage, revisionPage: p.revisionPage})), markupPolicy: policy, clearedMeasurements: current.takeoff.records.length - takeoff.records.length, clearedScales: current.takeoff.scales.length - takeoff.scales.length};
      if (await hash(current.bytes) !== entry.baseSha256) throw new Error('Current source hash changed after review.');
      const committed = await commit({expected: current, sourceId, sourceBytes: captured.donor.bytes, pages, markups, takeoff, entry});
      if (!committed) throw new Error('Replacement was not committed. The current document may have changed.');
      plan = undefined; review.hidden = true; status.textContent = insertion ? 'Revised sheets inserted and old sheets stamped SUPERSEDED. Existing navigation targets old sheets. Recalibrate new sheets. Undo restores the prior state.' : 'Revised sheets applied. Review retained annotations and recalibrate replaced pages. Undo restores the prior state.'; journal();
    } catch (e) { error.textContent = issue(e); error.hidden = false; status.textContent = 'Replacement failed; no new revision committed.'; }
    finally { for (const task of tasks) await task.destroy().catch(() => {}); applying = false; dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(c => c.disabled = false); approved.checked = false; button('apply').disabled = true; modeText(); journal(); }
  };
  return {open() { reset(); modeText(); targetId = getActiveId(); select.replaceChildren(); for (const d of getDocuments()) select.add(new Option(d.name, d.id)); select.value = getDocuments().find(d => d.id !== targetId)?.id ?? targetId; journal(); dialog.showModal(); }};
}
