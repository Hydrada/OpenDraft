import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildRedactedPdf, validateRedactions, type RedactedRaster, type RedactionArea } from './redaction';
import { applyOcrTextLayer, type OcrPage, type OcrWord } from './ocr-text';

type Options = {
  document: () => { name: string; bytes: Uint8Array; pdf: PDFDocumentProxy; pageIndex: number } | undefined;
  download: (bytes: Uint8Array, name: string) => void;
  error: (message: string) => void;
};
/** Rasters are capped so a 36x48 in sheet stays within browser canvas limits (about 150 dpi). */
const TARGET_DPI = 200, MAX_PIXELS = 40_000_000;

/**
 * Redaction panel. Areas are collected per document and applied by rebuilding each affected page
 * from a raster with the areas painted solid, so nothing underneath survives. The open document
 * is never changed; the result is downloaded as a separate copy.
 */
export function mountRedaction(container: HTMLElement, options: Options) {
  container.innerHTML = '<h3>Redaction</h3><p>Redaction permanently removes content. Each page with a redaction is replaced by an image of that page with the areas blacked out, so its text is no longer selectable or searchable. The open document is not changed; a redacted copy is saved.</p>';
  const areas = new Map<Uint8Array, RedactionArea[]>();
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Redaction status');
  const list = document.createElement('ul'); list.setAttribute('aria-label', 'Redaction areas');
  const field = (label: string, value = '') => { const row = document.createElement('label'); row.textContent = label; const input = document.createElement('input'); input.setAttribute('aria-label', label); input.value = value; row.append(input); container.append(row); return input; };
  const button = (label: string, run: () => Promise<void> | void) => {
    const item = document.createElement('button'); item.textContent = label;
    item.onclick = async () => { item.disabled = true; try { await run(); } catch (e) { const text = e instanceof Error ? e.message : String(e); status.textContent = text; options.error(text); } finally { item.disabled = false; } };
    container.append(item); return item;
  };
  const current = () => { const doc = options.document(); if (!doc) throw new Error('Open a PDF first.'); return doc; };
  const listFor = (bytes: Uint8Array) => { let value = areas.get(bytes); if (!value) areas.set(bytes, value = []); return value; };
  const render = () => {
    const doc = options.document(); list.replaceChildren();
    const items = doc ? areas.get(doc.bytes) ?? [] : [];
    items.forEach((area, index) => {
      const row = document.createElement('li'); row.textContent = `Page ${area.pageIndex + 1}: ${area.rect.map(v => Math.round(v * 100) / 100).join(', ')} `;
      const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove redaction area ${index + 1}`);
      remove.onclick = () => { items.splice(index, 1); render(); };
      row.append(remove); list.append(row);
    });
    status.textContent = items.length ? `${items.length} area(s) marked for redaction.` : 'No redaction areas marked.';
  };

  const coords = field('Redaction area (x1,y1;x2,y2 in PDF units)', '');
  button('Add redaction area on current page', () => {
    const doc = current();
    const pairs = coords.value.split(/[;\n]/).map(pair => pair.split(',').map(Number));
    if (pairs.length !== 2 || pairs.some(pair => pair.length !== 2)) throw new Error('Enter two corners as x1,y1;x2,y2.');
    const [area] = validateRedactions([{ pageIndex: doc.pageIndex, rect: [pairs[0][0], pairs[0][1], pairs[1][0], pairs[1][1]] }], doc.pdf.numPages);
    listFor(doc.bytes).push(area); render();
  });
  const term = field('Redact every occurrence of text');
  button('Mark text matches for redaction', async () => {
    const doc = current(), needle = term.value.trim().toLocaleLowerCase();
    if (!needle) throw new Error('Enter text to search for.');
    let found = 0;
    for (let n = 1; n <= doc.pdf.numPages; n++) {
      const page = await doc.pdf.getPage(n), content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.toLocaleLowerCase().includes(needle)) continue;
        // Whole text run, padded: conservative coverage of the match and its glyph extents.
        const [a, b, c, d, e, f] = item.transform, height = Math.hypot(c, d) || Math.hypot(a, b), width = item.width || height * item.str.length * 0.6;
        const angle = Math.atan2(b, a), cos = Math.cos(angle), sin = Math.sin(angle), pad = height * 0.25;
        const corners = [[-pad, -pad * 1.2], [width + pad, -pad * 1.2], [width + pad, height + pad], [-pad, height + pad]].map(([x, y]) => [e + x * cos - y * sin, f + x * sin + y * cos]);
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        listFor(doc.bytes).push({ pageIndex: n - 1, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }); found++;
      }
    }
    render();
    status.textContent = `${found} text match(es) marked across ${doc.pdf.numPages} page(s). Review the list, then apply.`;
  });
  const keepText = document.createElement('input'); keepText.type = 'checkbox'; keepText.checked = true; keepText.setAttribute('aria-label', 'Keep other text on redacted pages searchable');
  const keepRow = document.createElement('label'); keepRow.append(keepText, ' Keep other text on redacted pages searchable (text touching a redaction box is always removed)'); container.append(keepRow);
  button('Clear redaction areas', () => { const doc = current(); areas.set(doc.bytes, []); render(); });
  button('Apply redactions and save copy', async () => {
    const doc = current(), items = validateRedactions(areas.get(doc.bytes) ?? [], doc.pdf.numPages);
    if (!items.length) throw new Error('Mark at least one redaction area first.');
    const rasters = new Map<number, RedactedRaster>();
    for (const pageIndex of new Set(items.map(area => area.pageIndex))) {
      status.textContent = `Rendering page ${pageIndex + 1} for redaction…`;
      rasters.set(pageIndex, await rasterize(doc.pdf, pageIndex, items.filter(area => area.pageIndex === pageIndex)));
    }
    let bytes = await buildRedactedPdf(doc.bytes, items, rasters);
    if (keepText.checked) {
      // Re-add the page's own text as invisible text, minus every run that touches a redaction box.
      const pages: OcrPage[] = [];
      for (const pageIndex of rasters.keys()) pages.push({ pageIndex, words: await survivingText(doc.pdf, pageIndex, items.filter(area => area.pageIndex === pageIndex)) });
      bytes = (await applyOcrTextLayer(bytes, pages, { minConfidence: 0 })).bytes;
    }
    options.download(bytes, `${doc.name.replace(/\.pdf$/i, '')}-redacted.pdf`);
    status.textContent = `Saved a redacted copy: ${rasters.size} page(s) replaced, ${items.length} area(s) removed. The open document is unchanged.`;
  });
  container.append(list, status);
  render();
  return { refresh: render };
}

async function rasterize(pdf: PDFDocumentProxy, pageIndex: number, items: readonly RedactionArea[]): Promise<RedactedRaster> {
  const page = await pdf.getPage(pageIndex + 1), base = page.getViewport({ scale: 1 });
  const scale = Math.min(TARGET_DPI / 72, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false })!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  context.fillStyle = '#000';
  for (const area of items) {
    const [x1, y1] = viewport.convertToViewportPoint(area.rect[0], area.rect[1]), [x2, y2] = viewport.convertToViewportPoint(area.rect[2], area.rect[3]);
    context.fillRect(Math.floor(Math.min(x1, x2)) - 1, Math.floor(Math.min(y1, y2)) - 1, Math.ceil(Math.abs(x2 - x1)) + 2, Math.ceil(Math.abs(y2 - y1)) + 2);
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode the redacted page.')), 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  canvas.width = canvas.height = 0; page.cleanup();
  return { png, width: base.width, height: base.height };
}

/** Text runs on a page that do not touch any redaction area, mapped into the rebuilt (upright) page. */
async function survivingText(pdf: PDFDocumentProxy, pageIndex: number, areas: readonly RedactionArea[]): Promise<OcrWord[]> {
  const page = await pdf.getPage(pageIndex + 1), view = page.getViewport({ scale: 1 }), content = await page.getTextContent();
  const words: OcrWord[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform, height = Math.hypot(c, d) || Math.hypot(a, b), length = Math.hypot(a, b) || 1;
    const width = item.width || height * item.str.length * 0.6, ux = a / length, uy = b / length;
    // Conservative box in PDF space: the run plus a quarter of its height on every side.
    const pad = height * 0.25, corners = [[-pad, -pad], [width + pad, -pad], [width + pad, height + pad], [-pad, height + pad]].map(([x, y]) => [e + x * ux - y * uy, f + x * uy + y * ux]);
    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (areas.some(({ rect }) => rect[0] < box[2] && rect[2] > box[0] && rect[1] < box[3] && rect[3] > box[1])) continue;
    // Map into the rebuilt page, whose origin is the lower-left of the upright view.
    const toNew = (x: number, y: number) => { const [vx, vy] = view.convertToViewportPoint(x, y); return [vx, view.height - vy]; };
    const origin = toNew(e, f), right = toNew(e + width * ux, f + width * uy), top = toNew(e - height * uy, f + height * ux);
    words.push({ text: item.str, confidence: 100, x: origin[0], y: origin[1], width: Math.hypot(right[0] - origin[0], right[1] - origin[1]), height: Math.hypot(top[0] - origin[0], top[1] - origin[1]), angle: Math.atan2(right[1] - origin[1], right[0] - origin[0]) });
  }
  page.cleanup();
  return words;
}
