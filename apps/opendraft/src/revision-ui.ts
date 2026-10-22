import { pdfResources } from './pdf-resources';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { compareRasters, comparisonGeometry, type RasterPage } from './revision-comparison';
import { affineGeometry, similarityTransform, transformForComparison, type AffineTransform } from './revision-transform';
import {mountDifferenceCloudReview, type CloudSnapshot, type CommitDifferenceClouds} from './difference-cloud-ui';

type Source = {id: string; name: string; bytes: Uint8Array; pageCount: number; currentPage: number};
type Run = {cancelled: boolean; tasks: ReturnType<typeof pdfjs.getDocument>[]};
type Capture = {rasters: [RasterPage, RasterPage]; evidence: Record<string, unknown>; threshold: number; scale: number; sources:[Source,Source];geometry:CloudSnapshot['geometry'];pageIndex:number};
type AlignmentCandidate = {matrix: AffineTransform; scale: number; rotationDegrees: number; matches: number; inliers: number; residualPixels: number; coverage: number; method: string};
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const issue = (e: unknown) => e instanceof Error ? e.message : String(e);
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), b => b.toString(16).padStart(2, '0')).join('');
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode comparison image.')), 'image/png'));
}

/** Isolated read-only snapshots: never uses or mutates the active viewer's PDF worker. */
export function mountRevisionComparison(getDocuments: () => Source[], getActiveId: () => string, commitClouds:CommitDifferenceClouds) {
  const dialog = document.createElement('dialog');
  dialog.className = 'revision-dialog';
  dialog.setAttribute('aria-labelledby', 'revision-title');
  dialog.innerHTML = `<h2 id="revision-title">Drawing revision comparison</h2>
    <p>Compare snapshots of two open pages. Comparison leaves documents unchanged. Reviewed difference clouds can be added separately to the base drawing. PDF default layer visibility is used; viewer layer toggles are not applied.</p>
    <div class="revision-fields">
      <fieldset><legend>Base drawing (red)</legend><label>Base document<select aria-label="Comparison base document"></select></label><label>Base page<input aria-label="Comparison base page" type="number" min="1" step="1" value="1"></label></fieldset>
      <fieldset><legend>Revision drawing (blue)</legend><label>Revision document<select aria-label="Comparison revision document"></select></label><label>Revision page<input aria-label="Comparison revision page" type="number" min="1" step="1" value="1"></label></fieldset>
      <fieldset><legend>Alignment and sensitivity</legend><label>Resolution<select aria-label="Comparison resolution"><option value="36">36 dpi</option><option value="72" selected>72 dpi</option><option value="108">108 dpi</option><option value="144">144 dpi</option></select></label><label>Revision horizontal offset (points)<input aria-label="Revision horizontal offset" type="number" step="any" value="0"></label><label>Revision vertical offset (points)<input aria-label="Revision vertical offset" type="number" step="any" value="0"></label><label>Revision scale (0.1–10)<input aria-label="Revision alignment scale" type="number" step="any" min="0.1" max="10" value="1"></label><label>Revision clockwise rotation (degrees)<input aria-label="Revision alignment rotation" type="number" step="any" value="0"></label><label>Channel difference threshold (0–255)<input aria-label="Comparison threshold" type="number" min="0" max="255" step="1" value="16"></label></fieldset>
    </div>
    <p>Offsets use the displayed page's top-left origin: positive moves the revision right/down. Scale and clockwise rotation use that origin, followed by translation. One point is 1/72 inch; manual offsets round to output pixels. Page rotation, CropBox and UserUnit are applied by the renderer. Automatic estimates require review and apply only to this comparison.</p>
    <div class="revision-actions"><button type="button" data-action="run">Compare pages</button><button type="button" data-action="estimate" disabled>Estimate alignment</button><button type="button" data-action="cancel" disabled>Cancel comparison</button><button type="button" data-action="close">Close comparison</button></div>
    <section aria-label="Alignment review" hidden><h3>Review estimated alignment</h3><p data-alignment-summary></p><p>Feature matches can be wrong, especially on repeated patterns. Review the overlay after applying. This does not change source PDFs, drawing calibration or measurement quantities.</p><button type="button" data-action="apply-alignment">Apply alignment to comparison</button><button type="button" data-action="discard-alignment">Discard alignment estimate</button></section>
    <p role="status" aria-label="Comparison status">Choose pages and compare.</p><p role="alert" aria-label="Comparison error" hidden></p>
    <section aria-label="Comparison result" hidden><label>View<select aria-label="Comparison view"><option value="overlay">Color overlay</option><option value="difference">Differences</option></select></label>
    <p>Overlay: red = base ink, blue = revision ink, black = shared ink. Differences: red = darker base, blue = darker revision, magenta = other color change; unchanged content is light gray. Pixel differences are visual evidence, not verified engineering changes.</p>
    <p data-summary></p><canvas aria-label="Drawing comparison image"></canvas>
    <div class="revision-actions"><button type="button" data-action="png">Export comparison PNG</button><button type="button" data-action="pdf">Export comparison PDF</button><button type="button" data-action="json">Export comparison evidence JSON</button></div><section data-cloud-tools aria-label="Difference cloud tools"></section></section>`;
  document.body.append(dialog);
  const find = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  const field = (name: string) => find<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`);
  const baseSelect = field('Comparison base document') as HTMLSelectElement;
  const revisionSelect = field('Comparison revision document') as HTMLSelectElement;
  const status = find<HTMLElement>('[aria-label="Comparison status"]');
  const error = find<HTMLElement>('[aria-label="Comparison error"]');
  const result = find<HTMLElement>('[aria-label="Comparison result"]');
  const canvas = find<HTMLCanvasElement>('canvas');
  const button = (name: string) => find<HTMLButtonElement>(`[data-action="${name}"]`);
  let running: Run | undefined;
  let captured: Capture | undefined;
  let estimate: {worker: Worker; capture: Capture; id: number; timer: ReturnType<typeof setTimeout>} | undefined;
  let proposal: {capture: Capture; result: AlignmentCandidate} | undefined;
  let estimateId = 0;
  let saved: CloudSnapshot | undefined;
  const clouds=mountDifferenceCloudReview(find<HTMLElement>('[data-cloud-tools]'),()=>saved,getDocuments,commitClouds);
  function busy(value: boolean) {
    button('run').disabled = value; button('cancel').disabled = !value;
    button('estimate').disabled = value || !captured;
  }
  function cancel() {
    if (estimate) { clearTimeout(estimate.timer); estimate.worker.terminate(); estimate = undefined; }
    if (running) {
      running.cancelled = true;
      for (const task of running.tasks) void task.destroy().catch(() => {});
      running = undefined;
    }
    busy(false);
  }
  function invalidate() {
    clouds.invalidate();
    captured = undefined; proposal = undefined; find<HTMLElement>('[aria-label="Alignment review"]').hidden = true;
    cancel(); saved = undefined; result.hidden = true; canvas.width = canvas.height = 0;
    error.hidden = true; status.textContent = 'Settings changed. Compare pages to refresh the evidence.';
  }
  function refreshPageLimit(select: HTMLSelectElement, pageName: string, reset: boolean) {
    const source = getDocuments().find(d => d.id === select.value), page = field(pageName) as HTMLInputElement;
    page.max = String(source?.pageCount ?? 1);
    if (reset) page.value = String(source?.currentPage ?? 1);
  }
  function draw() {
    if (!saved) return;
    const data = field('Comparison view').value === 'difference' ? saved.pixels.difference : saved.pixels.overlay;
    canvas.width = saved.pixels.width; canvas.height = saved.pixels.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Comparison canvas is unavailable.');
    const image = context.createImageData(canvas.width, canvas.height); image.data.set(data); context.putImageData(image, 0, 0);
  }
  baseSelect.onchange = () => { refreshPageLimit(baseSelect, 'Comparison base page', true); invalidate(); };
  revisionSelect.onchange = () => { refreshPageLimit(revisionSelect, 'Comparison revision page', true); invalidate(); };
  dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.revision-fields input, .revision-fields select').forEach(control => {
    control.addEventListener('input', invalidate);
  });
  field('Comparison view').onchange = draw;
  button('close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { invalidate(); });
  dialog.addEventListener('cancel', () => { cancel(); });
  button('cancel').onclick = () => { invalidate(); status.textContent = 'Comparison cancelled. Sources are unchanged.'; };
  button('run').onclick = async () => {
    invalidate();
    const run: Run = {cancelled: false, tasks: []}; running = run; busy(true);
    const live = () => running === run && !run.cancelled && dialog.open;
    const ensureLive = () => { if (!live()) throw new Error('Comparison cancelled.'); };
    const canvases: HTMLCanvasElement[] = [];
    try {
      const documents = getDocuments();
      const selected = [baseSelect.value, revisionSelect.value].map(id => documents.find(d => d.id === id));
      if (!selected[0] || !selected[1]) throw new Error('Selected drawing is no longer open. Close and reopen comparison.');
      const sources = selected as [Source, Source];
      const pageNumbers = ['Comparison base page', 'Comparison revision page'].map((name, i) => {
        const value = Number(field(name).value);
        if (!Number.isInteger(value) || value < 1 || value > sources[i].pageCount) throw new Error('Choose a valid page in each document.');
        return value;
      });
      const dpi = Number(field('Comparison resolution').value), scale = dpi / 72;
      const offsets = ['Revision horizontal offset', 'Revision vertical offset'].map(name => {
        const text = field(name).value, value = Number(text);
        if (!text.trim() || !Number.isFinite(value) || Math.abs(value) > 100000) throw new Error('Offsets must be finite points between -100000 and 100000.');
        return value;
      });
      const thresholdText = field('Comparison threshold').value, threshold = Number(thresholdText);
      if (!thresholdText.trim() || !Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Error('Threshold must be an integer from 0 to 255.');
      const alignmentValues = ['Revision alignment scale', 'Revision alignment rotation'].map(name => {
        const text = field(name).value, value = Number(text);
        if (!text.trim() || !Number.isFinite(value)) throw new Error('Alignment scale and rotation must be finite numbers.');
        return value;
      });
      if (![36, 72, 108, 144].includes(dpi)) throw new Error('Choose a supported resolution.');
      if (sources.some(source => source.bytes.byteLength > MAX_SOURCE_BYTES)) throw new Error('Comparison accepts at most 64 MiB per document snapshot.');
      const bytes = sources.map(source => source.bytes.slice());
      status.textContent = 'Loading isolated document snapshots…';
      // Own loading tasks avoid closing/replacing an active viewer document during async rendering.
      const docs = [];
      for (const data of bytes) {
        ensureLive();
        const task = pdfjs.getDocument({ ...pdfResources, data: data.slice(), enableXfa: false}); run.tasks.push(task);
        docs.push(await task.promise); ensureLive();
      }
      const pages = await Promise.all(docs.map((doc, i) => doc.getPage(pageNumbers[i]))); ensureLive();
      const viewports = pages.map(page => page.getViewport({scale}));
      const sizes = viewports.map(view => ({width: Math.ceil(view.width), height: Math.ceil(view.height)}));
      const offsetX = Math.round(offsets[0] * scale), offsetY = Math.round(offsets[1] * scale);
      const matrix = similarityTransform({scale: alignmentValues[0], rotationDegrees: alignmentValues[1], offsetX, offsetY});
      const translationOnly = alignmentValues[0] === 1 && alignmentValues[1] % 360 === 0;
      // Check both inputs and their translated union before allocating either canvas.
      const geometry = translationOnly ? comparisonGeometry(sizes[0], sizes[1], offsetX, offsetY) : affineGeometry(sizes[0], sizes[1], matrix);
      const rasters: RasterPage[] = [];
      for (let i = 0; i < pages.length; i++) {
        ensureLive(); status.textContent = `Rendering ${i === 0 ? 'base' : 'revision'} page at ${dpi} dpi…`;
        const surface = document.createElement('canvas'); canvases.push(surface);
        surface.width = sizes[i].width; surface.height = sizes[i].height;
        const context = surface.getContext('2d', {willReadFrequently: true});
        if (!context) throw new Error('Comparison canvas is unavailable.');
        await pages[i].render({canvas: surface, viewport: viewports[i], background: '#ffffff'}).promise; ensureLive();
        rasters.push({...sizes[i], data: context.getImageData(0, 0, surface.width, surface.height).data});
      }
      const hashes = await Promise.all(bytes.map(hash)); ensureLive();
      let pixels: ReturnType<typeof compareRasters>;
      if (translationOnly) pixels = compareRasters(rasters[0], rasters[1], {offsetX, offsetY, threshold});
      else {
        const transformed = transformForComparison(rasters[0], rasters[1], matrix);
        pixels = {...compareRasters(transformed.base, transformed.revision, {offsetX: 0, offsetY: 0, threshold}), ...geometry};
      }
      const evidence = {
        schema: 'opendraft.revision-comparison', version: 1, createdAt: new Date().toISOString(),
        renderer: {name: 'PDF.js', version: pdfjs.version, dpi, layerVisibility: 'PDF defaults', annotations: 'display appearances'},
        base: {name: sources[0].name, sha256: hashes[0], page: pageNumbers[0], pageCount: docs[0].numPages, rotation: pages[0].rotate, viewBox: pages[0].view, userUnit: pages[0].userUnit, ...sizes[0]},
        revision: {name: sources[1].name, sha256: hashes[1], page: pageNumbers[1], pageCount: docs[1].numPages, rotation: pages[1].rotate, viewBox: pages[1].view, userUnit: pages[1].userUnit, ...sizes[1]},
        alignment: {method: translationOnly ? 'explicit translation' : 'explicit similarity', matrix, scale: alignmentValues[0], rotationDegrees: alignmentValues[1], resampling: translationOnly ? 'integer translation' : 'inverse bilinear over white', requestedPoints: {x: offsets[0], y: offsets[1]}, appliedPixels: {x: offsetX, y: offsetY}, appliedPoints: {x: offsetX / scale, y: offsetY / scale}},
        comparison: {threshold, rule: 'max absolute RGB channel delta after white alpha composition > threshold', ...geometry, changedPixels: pixels.changedPixels, totalPixels: pixels.totalPixels, changedBounds: pixels.changedBounds},
        presentation: {overlay: 'White-composited weighted grayscale; RGB = [revisionGray, round(baseGray * revisionGray / 255), baseGray].', difference: {darkerBase: [220, 35, 45], darkerRevision: [25, 80, 220], otherColorChange: [180, 40, 180], unchanged: 'Light grayscale; round(224 + min(baseGray, revisionGray) * 31 / 255).'}, grayscale: 'round((299 * R + 587 * G + 114 * B) / 1000)'},
        limitations: ['Raster visual comparison; no semantic or engineering verification.', 'Automatic similarity estimates require explicit review and may be wrong; perspective/nonuniform registration is not inferred.', 'Pixel bounds use output top-left origin; union origin is relative to the base viewport.', 'Default PDF layers and display appearances only; viewer visibility toggles and unrendered content are excluded.', 'Comparison itself does not modify sources, markups, measurements or history. Reviewed cloud application is a separate explicit workspace edit.'],
      };
      captured = {rasters: rasters as [RasterPage, RasterPage], evidence, threshold, scale, sources, pageIndex:pageNumbers[0]-1, geometry:{width:viewports[0].width,height:viewports[0].height,transform:[...viewports[0].transform],viewBox:[...pages[0].view]}};
      saved = {...captured,pixels}; draw(); result.hidden = false;
      find<HTMLElement>('[data-summary]').textContent = `${pixels.changedPixels.toLocaleString('en-US')} of ${pixels.totalPixels.toLocaleString('en-US')} pixels differ (${(100 * pixels.changedPixels / pixels.totalPixels).toFixed(3)}%). Output ${pixels.width} × ${pixels.height} pixels. Applied offset ${offsetX / scale}, ${offsetY / scale} points, scale ${alignmentValues[0]}, clockwise rotation ${alignmentValues[1]}°. Review alignment and sensitivity before interpreting changes.`;
      status.textContent = 'Comparison ready. Evidence describes these snapshots and settings.';
    } catch (e) {
      if (live()) { error.hidden = false; error.textContent = issue(e); status.textContent = 'Comparison failed. Try lower resolution for resource limits. Sources are unchanged.'; }
    } finally {
      for (const surface of canvases) surface.width = surface.height = 0;
      await Promise.allSettled(run.tasks.map(task => task.destroy()));
      if (running === run) { running = undefined; busy(false); }
    }
  };
  button('estimate').onclick = () => {
    const capture = captured;
    if (!capture || running || estimate) return;
    clouds.invalidate();proposal = undefined; find<HTMLElement>('[aria-label="Alignment review"]').hidden = true;
    error.hidden = true;
    let worker: Worker;
    try { worker = new Worker(new URL('./alignment-worker.ts', import.meta.url), {type: 'module'}); }
    catch (e) { error.hidden = false; error.textContent = `Could not start alignment: ${issue(e)}`; return; }
    const id = ++estimateId;
    const finish = (message?: string) => {
      if (estimate?.id !== id) return;
      clearTimeout(estimate.timer); worker.terminate(); estimate = undefined; busy(false);
      if (message) { error.hidden = false; error.textContent = message; status.textContent = 'Estimate unavailable. Review manual alignment or choose pages with more shared linework.'; }
    };
    const timer = setTimeout(() => finish('Alignment estimation exceeded the 15-second limit.'), 15000);
    estimate = {worker, capture, id, timer}; busy(true);
    status.textContent = 'Estimating shared features locally. No alignment has been applied.';
    worker.onerror = event => { event.preventDefault(); finish('Alignment worker failed. Manual comparison remains available.'); };
    worker.onmessage = event => {
      if (estimate?.id !== id || event.data?.id !== id || captured !== capture || !dialog.open) return;
      if (event.data.error) { finish(String(event.data.error)); return; }
      try {
        const candidate = event.data.result as AlignmentCandidate;
        // A candidate that would exceed the current comparison budget is never offered for apply.
        affineGeometry(capture.rasters[0], capture.rasters[1], candidate.matrix);
        proposal = {capture, result: candidate};
        find<HTMLElement>('[data-alignment-summary]').textContent = `Proposed scale ${candidate.scale.toFixed(6)}, clockwise rotation ${candidate.rotationDegrees.toFixed(4)}°, horizontal offset ${(candidate.matrix[4] / capture.scale).toFixed(4)} points, vertical offset ${(candidate.matrix[5] / capture.scale).toFixed(4)} points. ${candidate.inliers} of ${candidate.matches} matches support this fit; fit error ${candidate.residualPixels.toFixed(3)} pixels. No changes applied.`;
        find<HTMLElement>('[aria-label="Alignment review"]').hidden = false;
        finish(); status.textContent = 'Alignment estimate ready for review. Current comparison is unchanged.';
      } catch (e) { finish(`Alignment estimate rejected: ${issue(e)}`); }
    };
    const base = {...capture.rasters[0], data: capture.rasters[0].data.slice()};
    const revision = {...capture.rasters[1], data: capture.rasters[1].data.slice()};
    try { worker.postMessage({id, base, revision}, [base.data.buffer, revision.data.buffer]); }
    catch (e) { finish(`Could not send alignment snapshots: ${issue(e)}`); }
  };
  button('discard-alignment').onclick = () => {
    proposal = undefined; find<HTMLElement>('[aria-label="Alignment review"]').hidden = true;
    status.textContent = 'Alignment estimate discarded. Current comparison is unchanged.';
  };
  button('apply-alignment').onclick = () => {
    const pending = proposal;
    if (!pending || pending.capture !== captured || !dialog.open || running || estimate) return;
    try {
      const {capture, result: candidate} = pending;
      const transformed = transformForComparison(capture.rasters[0], capture.rasters[1], candidate.matrix);
      const pixels = {...compareRasters(transformed.base, transformed.revision, {offsetX: 0, offsetY: 0, threshold: capture.threshold}), ...transformed.geometry};
      const previous = capture.evidence.comparison as Record<string, unknown>;
      const alignment = {method: 'reviewed automatic similarity', matrix: [...candidate.matrix], scale: candidate.scale, rotationDegrees: candidate.rotationDegrees, resampling: 'inverse bilinear over white', appliedPixels: {x: candidate.matrix[4], y: candidate.matrix[5]}, appliedPoints: {x: candidate.matrix[4] / capture.scale, y: candidate.matrix[5] / capture.scale}, proposal: {...candidate, matrix: [...candidate.matrix]}, reviewedAt: new Date().toISOString(), reviewScope: 'Applied explicitly to captured comparison only; not engineering acceptance or calibration.'};
      clouds.invalidate();
      saved = {...capture,pixels, evidence: {...capture.evidence, alignment, comparison: {...previous, ...transformed.geometry, changedPixels: pixels.changedPixels, totalPixels: pixels.totalPixels, changedBounds: pixels.changedBounds}}};
      // Values reflect the accepted candidate; editing them starts a new manual comparison.
      field('Revision alignment scale').value = String(candidate.scale);
      field('Revision alignment rotation').value = String(candidate.rotationDegrees);
      field('Revision horizontal offset').value = String(candidate.matrix[4] / capture.scale);
      field('Revision vertical offset').value = String(candidate.matrix[5] / capture.scale);
      proposal = undefined; find<HTMLElement>('[aria-label="Alignment review"]').hidden = true;
      draw(); result.hidden = false;
      find<HTMLElement>('[data-summary]').textContent = `${pixels.changedPixels.toLocaleString('en-US')} of ${pixels.totalPixels.toLocaleString('en-US')} pixels differ (${(100 * pixels.changedPixels / pixels.totalPixels).toFixed(3)}%) after reviewed alignment. Output ${pixels.width} × ${pixels.height} pixels. Resampling can create edge differences; review the overlay and original drawings.`;
      status.textContent = 'Reviewed alignment applied to these comparison snapshots. Source drawings and measurements are unchanged.';
    } catch (e) { error.hidden = false; error.textContent = `Could not apply alignment: ${issue(e)}`; }
  };
  button('json').onclick = () => {
    if (saved) download(new Blob([JSON.stringify({...saved.evidence, exportedView: field('Comparison view').value}, null, 2)], {type: 'application/json'}), 'revision-comparison.json');
  };
  async function exportImage(asPdf: boolean) {
    const snapshot = saved, view = field('Comparison view').value;
    if (!snapshot) return;
    try {
      const image = await png(canvas);
      if (saved !== snapshot || view !== field('Comparison view').value || !dialog.open) return;
      if (!asPdf) download(image, `revision-${view}.png`);
      else {
        const pdf = await PDFDocument.create();
        pdf.setTitle(`OpenDraft raster revision ${view}`);
        pdf.setSubject('Visual comparison only; review source snapshots and exported JSON evidence.');
        await pdf.attach(new TextEncoder().encode(JSON.stringify({...snapshot.evidence, exportedView: view}, null, 2)), 'revision-comparison.json', {mimeType: 'application/json', description: 'Source snapshot hashes, raster settings, alignment and comparison evidence'});
        const embedded = await pdf.embedPng(await image.arrayBuffer());
        const width = snapshot.pixels.width / snapshot.scale, height = snapshot.pixels.height / snapshot.scale;
        const page = pdf.addPage([width, height]); page.drawImage(embedded, {x: 0, y: 0, width, height});
        const data = await pdf.save();
        if (saved === snapshot && view === field('Comparison view').value && dialog.open) download(new Blob([data.slice().buffer], {type: 'application/pdf'}), `revision-${view}.pdf`);
      }
    } catch (e) { if (saved === snapshot) { error.hidden = false; error.textContent = `Could not export comparison: ${issue(e)}`; } }
  }
  button('png').onclick = () => { void exportImage(false); };
  button('pdf').onclick = () => { void exportImage(true); };
  return {
    open() {
      if (dialog.open) return;
      invalidate();
      const sources = getDocuments();
      for (const select of [baseSelect, revisionSelect]) {
        select.replaceChildren(...sources.map(source => {const option = document.createElement('option'); option.value = source.id; option.textContent = source.name; return option;}));
      }
      baseSelect.value = getActiveId();
      if (!baseSelect.value && sources[0]) baseSelect.value = sources[0].id;
      revisionSelect.value = sources.find(source => source.id !== baseSelect.value)?.id ?? baseSelect.value;
      refreshPageLimit(baseSelect, 'Comparison base page', true); refreshPageLimit(revisionSelect, 'Comparison revision page', true);
      status.textContent = sources.length ? 'Choose pages and compare. Current document snapshots are captured when you compare.' : 'Open at least one PDF before comparing pages.';
      button('run').disabled = !sources.length;
      dialog.showModal();
    },
  };
}
