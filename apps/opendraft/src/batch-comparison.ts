import { pdfResources } from './pdf-resources.ts';
import type * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';
import { compareRasters, comparisonGeometry, COMPARISON_LIMITS, type RasterPage } from './revision-comparison.ts';
import { affineGeometry, similarityTransform, transformForComparison } from './revision-transform.ts';
import { validateSheetPairs, type SheetPair } from './sheet-pairing.ts';

export const BATCH_LIMITS = Object.freeze({ maxSourceBytes: 64 * 1024 * 1024, maxPages: 200, maxPairs: 100, maxProcessedPixels: 40_000_000, maxPngBytes: 32 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024 });
export type BatchSource = {name: string; bytes: Uint8Array; sha256: string; pageCount: number; labels: (string | null)[]};
export type BatchOptions = {dpi: number; threshold: number; view: 'overlay' | 'difference'; reviewedAt: string};
export type BatchResult = {id: string; basePage: number; revisionPage: number; status: 'compared' | 'failed'; baseLabel: string | null; revisionLabel: string | null; changedPixels?: number; error?: string; pngPath?: string; pdfPage?: number; [key: string]: unknown};
export type BatchManifest = {schema: 'opendraft.batch-revision-comparison'; version: 1; createdAt: string; base: Omit<BatchSource, 'bytes'>; revision: Omit<BatchSource, 'bytes'>; options: BatchOptions; pairs: SheetPair[]; results: BatchResult[]; unmatchedBase: number[]; unmatchedRevision: number[]; [key: string]: unknown};
const issue = (error: unknown) => error instanceof Error ? error.message : String(error);
function live(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Batch comparison cancelled.', 'AbortError'); }
async function hash(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), value => value.toString(16).padStart(2, '0')).join(''); }
function sourceBytes(source: {name: string; bytes: Uint8Array}) {
  if (typeof source.name !== 'string' || source.name.length > 1024 || !(source.bytes instanceof Uint8Array) || !source.bytes.length || source.bytes.length > BATCH_LIMITS.maxSourceBytes) throw new Error('Source requires a name and PDF bytes within the 64 MiB limit.');
  return source.bytes.slice();
}
function labelsFor(labels: string[] | null, count: number): (string | null)[] {
  if (labels !== null && (labels.length !== count || labels.some(label => typeof label !== 'string' || label.length > 4096))) throw new Error('PDF page labels are invalid or exceed 4096 characters.');
  return labels ? [...labels] : Array.from({length: count}, () => null);
}
function openPdf(runtime: typeof import('pdfjs-dist'), bytes: Uint8Array, signal?: AbortSignal) {
  live(signal);
  const task = runtime.getDocument({ ...pdfResources, data: bytes.slice()});
  const abort = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  return {task, async destroy() { signal?.removeEventListener('abort', abort); await task.destroy().catch(() => {}); }};
}
/** Captures exact source bytes and PDF labels using its own worker lifecycle. */
export async function inspectBatchSource(source: {name: string; bytes: Uint8Array}, signal?: AbortSignal): Promise<BatchSource> {
  const bytes = sourceBytes(source), name = source.name;
  live(signal);
  const runtime = await import('pdfjs-dist'); live(signal);
  const loaded = openPdf(runtime, bytes, signal);
  try {
    const pdf = await loaded.task.promise; live(signal);
    if (pdf.numPages < 1 || pdf.numPages > BATCH_LIMITS.maxPages) throw new Error('Batch sources must contain 1–200 pages.');
    const labels = labelsFor(await pdf.getPageLabels(), pdf.numPages); live(signal);
    const sha256 = await hash(bytes); live(signal);
    return {name, bytes, sha256, pageCount: pdf.numPages, labels};
  } catch (error) { live(signal); throw error; }
  finally { await loaded.destroy(); }
}
/** Quoted Unicode CSV, with spreadsheet formula prefixes neutralized. */
export function batchCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function validateBatchOptions(options: BatchOptions): BatchOptions {
  if (!options || ![36, 72, 108, 144].includes(options.dpi) || !Number.isInteger(options.threshold) || options.threshold < 0 || options.threshold > 255 || !['overlay', 'difference'].includes(options.view) || typeof options.reviewedAt !== 'string' || !Number.isFinite(Date.parse(options.reviewedAt))) throw new Error('Batch requires supported DPI, threshold 0–255, output view and a valid review timestamp.');
  return {dpi: options.dpi, threshold: options.threshold, view: options.view, reviewedAt: options.reviewedAt};
}
function summaryCsv(manifest: BatchManifest) {
  const header = ['Pair', 'Base page', 'Base label', 'Revision page', 'Revision label', 'Status', 'Changed pixels', 'PNG', 'PDF page', 'Error'];
  const rows = manifest.results.map(result => [result.id, result.basePage, result.baseLabel, result.revisionPage, result.revisionLabel, result.status, result.changedPixels, result.pngPath, result.pdfPage, result.error]);
  return [header, ...rows].map(row => row.map(batchCsvCell).join(',')).join('\r\n') + '\r\n';
}
function png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) { reject(new Error('Could not encode comparison PNG.')); return; }
    blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
  }, 'image/png'));
}
function metadata(source: BatchSource): Omit<BatchSource, 'bytes'> { return {name: source.name, sha256: source.sha256, pageCount: source.pageCount, labels: [...source.labels]}; }

/** Sequential read-only batch; aborted jobs never return a downloadable partial archive. */
export async function runBatchComparison(base: BatchSource, revision: BatchSource, requestedPairs: SheetPair[], requestedOptions: BatchOptions, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<{zip: Uint8Array; manifest: BatchManifest}> {
  live(signal);
  const options = validateBatchOptions(requestedOptions);
  // Copy synchronously before the first await: caller mutation cannot alter a running job.
  const sources = [base, revision].map(source => {
    const bytes = sourceBytes(source);
    if (!Number.isInteger(source.pageCount) || source.pageCount < 1 || source.pageCount > BATCH_LIMITS.maxPages || !Array.isArray(source.labels) || source.labels.length !== source.pageCount || source.labels.some(label => label !== null && (typeof label !== 'string' || label.length > 4096))) throw new Error('Source page metadata is invalid.');
    return {...metadata(source), bytes};
  });
  const pairs = validateSheetPairs(requestedPairs, sources[0].pageCount, sources[1].pageCount);
  for (const source of sources) { if (await hash(source.bytes) !== source.sha256) throw new Error('Source snapshot changed after review. Prepare and review a new batch.'); live(signal); }
  const runtime = await import('pdfjs-dist'); live(signal);
  const loaded = sources.map(source => openPdf(runtime, source.bytes, signal));
  const canvases: HTMLCanvasElement[] = [];
  try {
    const docs = await Promise.all(loaded.map(value => value.task.promise)); live(signal);
    for (let i = 0; i < docs.length; i++) {
      if (docs[i].numPages !== sources[i].pageCount || JSON.stringify(labelsFor(await docs[i].getPageLabels(), docs[i].numPages)) !== JSON.stringify(sources[i].labels)) throw new Error('Source page metadata changed after review.');
      live(signal);
    }
    const manifest: BatchManifest = {
      schema: 'opendraft.batch-revision-comparison', version: 1, createdAt: new Date().toISOString(),
      base: metadata(sources[0]), revision: metadata(sources[1]), options, pairs, results: [],
      unmatchedBase: Array.from({length: sources[0].pageCount}, (_, i) => i + 1).filter(page => !pairs.some(pair => pair.basePage === page)),
      unmatchedRevision: Array.from({length: sources[1].pageCount}, (_, i) => i + 1).filter(page => !pairs.some(pair => pair.revisionPage === page)),
      renderer: {name: 'PDF.js', version: runtime.version, dpi: options.dpi, layerVisibility: 'PDF defaults', annotations: 'display appearances'},
      reviewScope: 'Explicit review of sheet pairing and settings; not engineering acceptance.',
      coordinates: 'Displayed top-left pixel origin after CropBox, page rotation and UserUnit. Matrix maps revision outer-rectangle coordinates to base. Bounds are output coordinates; union origin is base-relative.',
      comparisonRule: 'max absolute RGB channel delta after white alpha composition > threshold',
      palette: {overlay: '[revisionGray, round(baseGray * revisionGray / 255), baseGray, 255]', grayscale: 'round((299*R+587*G+114*B)/1000)', difference: {darkerBase: [220,35,45], darkerRevision: [25,80,220], otherColorChange: [180,40,180], unchanged: 'round(224+min(baseGray,revisionGray)*31/255)'}},
      limits: {...BATCH_LIMITS, ...COMPARISON_LIMITS},
      limitations: ['Raster visual evidence only; no semantic or engineering verification.', 'No automatic batch alignment; transforms are reviewed manual settings.', 'Default PDF layers/display appearances; viewer layer toggles are excluded.', 'No source PDF, markup, calibration, measurement or history changes.', 'Cancellation is checked between asynchronous stages; synchronous bounded comparison/ZIP stages are not interruptible.'],
    };
    const entries: Record<string, Uint8Array> = {};
    const pdf = await PDFDocument.create(); live(signal);
    pdf.setTitle('OpenDraft batch revision visual comparisons');
    pdf.setSubject('Raster visual evidence; inspect attached manifest and source drawings.');
    let processedPixels = 0, pngBytes = 0, pdfPages = 0;
    const scale = options.dpi / 72;
    for (let index = 0; index < pairs.length; index++) {
      live(signal);
      const pair = pairs[index];
      const result: BatchResult = {id: pair.id, basePage: pair.basePage, revisionPage: pair.revisionPage, baseLabel: sources[0].labels[pair.basePage - 1], revisionLabel: sources[1].labels[pair.revisionPage - 1], status: 'failed'};
      let pages: pdfjs.PDFPageProxy[] = [];
      try {
        pages = await Promise.all([docs[0].getPage(pair.basePage), docs[1].getPage(pair.revisionPage)]); live(signal);
        const views = pages.map(page => page.getViewport({scale}));
        const sizes = views.map(view => ({width: Math.ceil(view.width), height: Math.ceil(view.height)}));
        const offsetX = Math.round(pair.offsetX * scale), offsetY = Math.round(pair.offsetY * scale);
        const matrix = similarityTransform({scale: pair.scale, rotationDegrees: pair.rotationDegrees, offsetX, offsetY});
        const translationOnly = pair.scale === 1 && pair.rotationDegrees % 360 === 0;
        const geometry = translationOnly ? comparisonGeometry(sizes[0], sizes[1], offsetX, offsetY) : affineGeometry(sizes[0], sizes[1], matrix);
        const pixelCount = geometry.width * geometry.height;
        if (processedPixels + pixelCount > BATCH_LIMITS.maxProcessedPixels) throw new Error('Batch processed-pixel budget exhausted (40,000,000 pixels).');
        processedPixels += pixelCount;
        const rasters: RasterPage[] = [];
        for (let i = 0; i < pages.length; i++) {
          live(signal);
          const canvas = document.createElement('canvas'); canvases.push(canvas);
          canvas.width = sizes[i].width; canvas.height = sizes[i].height;
          const context = canvas.getContext('2d', {willReadFrequently: true});
          if (!context) throw new Error('Comparison canvas unavailable.');
          await pages[i].render({canvas, viewport: views[i], background: '#ffffff'}).promise; live(signal);
          rasters.push({...sizes[i], data: context.getImageData(0, 0, canvas.width, canvas.height).data});
        }
        let comparison;
        if (translationOnly) comparison = compareRasters(rasters[0], rasters[1], {offsetX, offsetY, threshold: options.threshold});
        else {
          const transformed = transformForComparison(rasters[0], rasters[1], matrix);
          comparison = {...compareRasters(transformed.base, transformed.revision, {offsetX: 0, offsetY: 0, threshold: options.threshold}), ...geometry};
        }
        live(signal);
        const surface = document.createElement('canvas'); canvases.push(surface);
        surface.width = comparison.width; surface.height = comparison.height;
        const context = surface.getContext('2d');
        if (!context) throw new Error('Comparison canvas unavailable.');
        const image = context.createImageData(surface.width, surface.height);
        image.data.set(options.view === 'overlay' ? comparison.overlay : comparison.difference); context.putImageData(image, 0, 0);
        const imageBytes = await png(surface); live(signal);
        if (pngBytes + imageBytes.length > BATCH_LIMITS.maxPngBytes) throw new Error('Batch PNG budget exhausted (32 MiB).');
        const pngSha256 = await hash(imageBytes); live(signal);
        const embedded = await pdf.embedPng(imageBytes); live(signal);
        const width = comparison.width / scale, height = comparison.height / scale;
        const page = pdf.addPage([width, height]); page.drawImage(embedded, {x: 0, y: 0, width, height});
        const pngPath = `images/pair-${String(index + 1).padStart(3, '0')}.png`;
        entries[pngPath] = imageBytes; pngBytes += imageBytes.length; pdfPages++;
        Object.assign(result, {status: 'compared', changedPixels: comparison.changedPixels, totalPixels: comparison.totalPixels, changedBounds: comparison.changedBounds, geometry, pngPath, pngSha256, pngBytes: imageBytes.length, pdfPage: pdfPages,
          base: {page: pair.basePage, label: result.baseLabel, rotation: pages[0].rotate, viewBox: [...pages[0].view], userUnit: pages[0].userUnit, ...sizes[0]},
          revision: {page: pair.revisionPage, label: result.revisionLabel, rotation: pages[1].rotate, viewBox: [...pages[1].view], userUnit: pages[1].userUnit, ...sizes[1]},
          alignment: {method: translationOnly ? 'explicit translation' : 'explicit similarity', matrix, scale: pair.scale, rotationDegrees: pair.rotationDegrees, requestedPoints: {x: pair.offsetX, y: pair.offsetY}, appliedPixels: {x: offsetX, y: offsetY}, appliedPoints: {x: offsetX / scale, y: offsetY / scale}, resampling: translationOnly ? 'integer translation' : 'inverse bilinear over white'}, physicalSizePoints: {width, height}});
      } catch (error) { live(signal); result.error = issue(error); }
      finally {
        for (const canvas of canvases.splice(0)) canvas.width = canvas.height = 0;
        for (const page of pages) page.cleanup();
      }
      manifest.results.push(result);
      onProgress?.(index + 1, pairs.length); live(signal);
      // Yield between sheets so cancellation/input events can be delivered.
      await new Promise(resolve => setTimeout(resolve, 0)); live(signal);
    }
    manifest.processedPixels = processedPixels; manifest.encodedPngBytes = pngBytes;
    manifest.pdfPath = pdfPages ? 'comparisons.pdf' : null;
    const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
    if (pdfPages) {
      await pdf.attach(manifestBytes, 'manifest.json', {mimeType: 'application/json', description: 'Reviewed source snapshot hashes, sheet pairing, transforms and per-sheet results'}); live(signal);
      const pdfBytes = await pdf.save(); live(signal);
      if (pdfBytes.length > BATCH_LIMITS.maxOutputBytes) throw new Error('Batch PDF exceeds the 64 MiB output limit.');
      entries['comparisons.pdf'] = pdfBytes;
    }
    entries['manifest.json'] = manifestBytes; entries['summary.csv'] = strToU8(summaryCsv(manifest));
    // Bound the stored archive before its contiguous allocation (ZIP headers included).
    const archiveBytes = Object.entries(entries).reduce((total, [name, bytes]) => total + bytes.length + 128 + 2 * strToU8(name).length, 22);
    if (archiveBytes > BATCH_LIMITS.maxOutputBytes) throw new Error('Batch archive exceeds the 64 MiB output limit.');
    // Stored entries avoid extra compression work; PNG/PDF are already compressed.
    const zip = zipSync(entries, {level: 0}); live(signal);
    if (zip.length > BATCH_LIMITS.maxOutputBytes) throw new Error('Batch archive exceeds the 64 MiB output limit.');
    return {zip, manifest};
  } catch (error) { live(signal); throw error; }
  finally { for (const canvas of canvases) canvas.width = canvas.height = 0; await Promise.allSettled(loaded.map(value => value.destroy())); }
}

