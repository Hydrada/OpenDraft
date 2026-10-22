import {inspectBatchSource, runBatchComparison, type BatchSource} from './batch-comparison';
import {pairSheets, validateSheetPairs, type SheetPair} from './sheet-pairing';

type Source = {id: string; name: string; bytes: Uint8Array};
/** A reviewed plan holds isolated source bytes; any control change revokes its approval. */
export function mountBatchComparison(getDocuments: () => Source[], getActiveId: () => string) {
  const dialog = document.createElement('dialog');
  dialog.className = 'revision-dialog batch-dialog';
  dialog.setAttribute('aria-labelledby', 'batch-title');
  dialog.innerHTML = `<h2 id="batch-title">Batch drawing revision review</h2>
    <p>Pair sheets from two open PDFs, review every match, then compare immutable snapshots. PDF default layer visibility is used. Visual differences do not verify engineering changes.</p>
    <div class="revision-fields"><label>Base PDF<select aria-label="Batch base document"></select></label><label>Revision PDF<select aria-label="Batch revision document"></select></label>
    <label>Pair sheets by<select aria-label="Batch pairing strategy"><option value="label">Unique PDF page labels</option><option value="order">Page order</option></select></label>
    <label>Resolution<select aria-label="Batch resolution"><option value="36">36 dpi</option><option value="72" selected>72 dpi</option><option value="108">108 dpi</option><option value="144">144 dpi</option></select></label>
    <label>Difference threshold<input aria-label="Batch threshold" type="number" min="0" max="255" step="1" value="16"></label>
    <label>Export view<select aria-label="Batch view"><option value="difference">Differences</option><option value="overlay">Color overlay</option></select></label></div>
    <div class="revision-actions"><button data-action="prepare">Prepare sheet pairs</button><button data-action="cancel" disabled>Cancel batch</button><button data-action="close">Close batch review</button></div>
    <section aria-label="Sheet pairing review" hidden><h3>Review sheet pairs</h3><p data-sources></p><p data-warnings></p>
    <p>Each base and revision page may appear once. Zero means excluded. Offsets are points (1/72 inch), positive right/down, rounded to output pixels. Scale and clockwise rotation use the revision top-left origin. Automatic alignment is available in the individual comparison workflow.</p>
    <div class="batch-table"><table><thead><tr><th>Base sheet</th><th>Revision sheet</th><th>Scale</th><th>Rotation °</th><th>X offset</th><th>Y offset</th></tr></thead><tbody></tbody></table></div>
    <p data-unmatched></p><label><input type="checkbox" aria-label="Approve batch sheet pairs"> I reviewed these pairs, exclusions and comparison settings.</label>
    <button data-action="run" disabled>Compare reviewed batch</button></section>
    <p role="status" aria-label="Batch status">Prepare a pairing plan.</p><p role="alert" aria-label="Batch error" hidden></p>
    <section aria-label="Batch results" hidden><h3>Batch results</h3><ol></ol><button data-action="export">Export batch ZIP</button><p>ZIP includes sheet PNGs, an image-only comparison PDF when any sheets succeed, JSON evidence and CSV summary. Failed and unmatched sheets are explicitly listed.</p></section>`;
  document.body.append(dialog);
  const find = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  const field = (name: string) => find<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`);
  const button = (action: string) => find<HTMLButtonElement>(`[data-action="${action}"]`);
  const baseSelect = field('Batch base document') as HTMLSelectElement, revisionSelect = field('Batch revision document') as HTMLSelectElement;
  const review = find<HTMLElement>('[aria-label="Sheet pairing review"]'), results = find<HTMLElement>('[aria-label="Batch results"]');
  const approved = field('Approve batch sheet pairs') as HTMLInputElement;
  const status = find<HTMLElement>('[aria-label="Batch status"]'), error = find<HTMLElement>('[aria-label="Batch error"]');
  let plan: {base: BatchSource; revision: BatchSource; pairs: SheetPair[]} | undefined;
  let controller: AbortController | undefined, generation = 0;
  let saved: Uint8Array | undefined;
  const issue = (e: unknown) => e instanceof Error ? e.message : String(e);
  function revoke() { approved.checked = false; button('run').disabled = true; saved = undefined; results.hidden = true; error.hidden = true; }
  function cancel() { generation++; controller?.abort(); controller = undefined; button('prepare').disabled = false; button('cancel').disabled = true; revoke(); }
  function reset() { cancel(); plan = undefined; review.hidden = true; status.textContent = 'Prepare a new pairing plan.'; }
  function unmatched() {
    if (!plan) return;
    const pairs = plan.pairs.filter(p => p.revisionPage > 0);
    const baseUsed = new Set(pairs.map(p => p.basePage)), revisionUsed = new Set(pairs.map(p => p.revisionPage));
    const missing = (count: number, used: Set<number>) => Array.from({length: count}, (_, i) => i + 1).filter(p => !used.has(p)).join(', ') || 'none';
    find<HTMLElement>('[data-unmatched]').textContent = `Unmatched/excluded base pages: ${missing(plan.base.pageCount, baseUsed)}. Unmatched revision pages: ${missing(plan.revision.pageCount, revisionUsed)}.`;
  }
  function selected() {
    if (!plan) throw new Error('Prepare a pairing plan first.');
    return validateSheetPairs(plan.pairs.filter(p => p.revisionPage > 0), plan.base.pageCount, plan.revision.pageCount);
  }
  function rows() {
    if (!plan) return;
    const body = find<HTMLTableSectionElement>('tbody'); body.replaceChildren();
    const label = (source: BatchSource, page: number) => `${page}${source.labels[page - 1] ? ` — ${source.labels[page - 1]}` : ''}`;
    for (const pair of plan.pairs) {
      const tr = document.createElement('tr'), name = document.createElement('th');
      name.scope = 'row'; name.textContent = label(plan.base, pair.basePage); tr.append(name);
      const td = document.createElement('td'), select = document.createElement('select');
      select.setAttribute('aria-label', `Revision for base page ${pair.basePage}`);
      select.add(new Option('Excluded', '0'));
      for (let page = 1; page <= plan.revision.pageCount; page++) select.add(new Option(label(plan.revision, page), String(page)));
      select.value = String(pair.revisionPage);
      select.onchange = () => { cancel(); pair.revisionPage = Number(select.value); pair.reason = 'manual'; unmatched(); };
      td.append(select); tr.append(td);
      for (const [key, title] of [['scale', 'Scale'], ['rotationDegrees', 'Rotation'], ['offsetX', 'X offset'], ['offsetY', 'Y offset']] as const) {
        const cell = document.createElement('td'), input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.value = String(pair[key]);
        input.setAttribute('aria-label', `${title} for base page ${pair.basePage}`);
        input.oninput = () => { cancel(); pair[key] = input.value.trim() ? Number(input.value) : NaN; };
        cell.append(input); tr.append(cell);
      }
      body.append(tr);
    }
    unmatched();
  }
  approved.onchange = () => {
    if (controller) { cancel(); status.textContent = 'Approval withdrawn. Batch cancelled.'; return; }
    error.hidden = true;
    try { selected(); button('run').disabled = !approved.checked || !!controller; }
    catch (e) { approved.checked = false; button('run').disabled = true; error.textContent = issue(e); error.hidden = false; }
  };
  baseSelect.onchange = reset; revisionSelect.onchange = reset; field('Batch pairing strategy').onchange = reset;
  for (const name of ['Batch resolution', 'Batch threshold', 'Batch view']) field(name).addEventListener('input', () => { if (controller) cancel(); revoke(); });
  button('close').onclick = () => dialog.close(); dialog.onclose = reset;
  dialog.addEventListener('cancel', cancel);
  button('cancel').onclick = () => { cancel(); status.textContent = 'Batch cancelled. No partial export retained.'; };
  button('prepare').onclick = async () => {
    reset(); const token = generation, abort = new AbortController(); controller = abort;
    button('prepare').disabled = true; button('cancel').disabled = false; status.textContent = 'Reading isolated source snapshots…';
    try {
      const sources = getDocuments(), base = sources.find(s => s.id === baseSelect.value), revision = sources.find(s => s.id === revisionSelect.value);
      if (!base || !revision) throw new Error('Open and select two PDF sources.');
      const a = await inspectBatchSource(base, abort.signal), b = await inspectBatchSource(revision, abort.signal);
      if (token !== generation || abort.signal.aborted) return;
      const pairing = pairSheets(a.labels, b.labels, field('Batch pairing strategy').value as 'label' | 'order');
      const paired = new Map(pairing.pairs.map(p => [p.basePage, p]));
      plan = {base: a, revision: b, pairs: Array.from({length: a.pageCount}, (_, i) => paired.get(i + 1) ?? {id: `manual-${i + 1}`, basePage: i + 1, revisionPage: 0, reason: 'manual', scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0})};
      find<HTMLElement>('[data-sources]').textContent = `${a.name}: ${a.pageCount} pages, SHA-256 ${a.sha256}. ${b.name}: ${b.pageCount} pages, SHA-256 ${b.sha256}.`;
      find<HTMLElement>('[data-warnings]').textContent = pairing.warnings.join(' ');
      rows(); review.hidden = false; status.textContent = 'Sheet pairs ready for review. Approval is revoked after any change.';
    } catch (e) { if (token === generation) { error.textContent = issue(e); error.hidden = false; status.textContent = 'Pairing could not be prepared.'; } }
    finally { if (token === generation) { controller = undefined; button('prepare').disabled = false; button('cancel').disabled = true; } }
  };
  button('run').onclick = async () => {
    if (!plan || !approved.checked || controller) return;
    const token = ++generation, abort = new AbortController(); controller = abort; saved = undefined; results.hidden = true; error.hidden = true;
    button('run').disabled = true; button('prepare').disabled = true; button('cancel').disabled = false;
    try {
      const pairs = selected();
      const output = await runBatchComparison(plan.base, plan.revision, pairs, {dpi: Number(field('Batch resolution').value), threshold: Number(field('Batch threshold').value), view: field('Batch view').value as 'overlay' | 'difference', reviewedAt: new Date().toISOString()}, abort.signal, (done, total) => { if (token === generation) status.textContent = `Comparing sheet ${done} of ${total}…`; });
      if (token !== generation || abort.signal.aborted) return;
      saved = output.zip; const list = find<HTMLOListElement>('[aria-label="Batch results"] ol'); list.replaceChildren();
      for (const result of output.manifest.results) { const li = document.createElement('li'); li.textContent = `Base ${result.basePage} → revision ${result.revisionPage}: ${result.status}${result.status === 'failed' ? ` — ${result.error}` : ` — ${result.changedPixels} changed pixels`}`; list.append(li); }
      const passed = output.manifest.results.filter(r => r.status === 'compared').length;
      status.textContent = `Batch ready: ${passed} compared, ${output.manifest.results.length - passed} failed. Review failures and unmatched sheets before using outputs.`;
      results.hidden = false;
    } catch (e) { if (token === generation) { error.textContent = issue(e); error.hidden = false; status.textContent = 'Batch failed. No export retained.'; } }
    finally { if (token === generation) { controller = undefined; button('prepare').disabled = false; button('cancel').disabled = true; approved.checked = false; } }
  };
  button('export').onclick = () => {
    if (!saved) return;
    const url = URL.createObjectURL(new Blob([saved.slice().buffer], {type: 'application/zip'})), link = document.createElement('a');
    link.href = url; link.download = 'opendraft-batch-comparison.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return {open() {
    reset(); const sources = getDocuments(); baseSelect.replaceChildren(); revisionSelect.replaceChildren();
    for (const source of sources) { baseSelect.add(new Option(source.name, source.id)); revisionSelect.add(new Option(source.name, source.id)); }
    baseSelect.value = sources[0]?.id ?? ''; revisionSelect.value = getActiveId();
    dialog.showModal();
  }};
}
