import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { STAMP_NAMES, validateMarkups, type Markup, type MarkupKind, type StampName } from './annotations.ts';
import type { MarkupComment } from './markup-comments.ts';

export type SkippedAnnotation = { pageIndex: number; subtype: string; reason: string };
export type ForeignImport = { bytes: Uint8Array; markups: Markup[]; skipped: SkippedAnnotation[] };

const IMPORTABLE = new Set(['Square', 'Circle', 'Line', 'Ink', 'Highlight', 'FreeText', 'Stamp', 'Polygon', 'Text']);
const IGNORED = new Set(['Link', 'Widget', 'Popup']); // navigation, form fields and popups are not markups

const text = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
const numbers = (value: unknown): number[] => value instanceof PDFArray ? value.asArray().map(item => item instanceof PDFNumber ? item.asNumber() : NaN) : [];
function pdfDate(value: string, fallback: string): string {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return fallback;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = match;
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() > 0 ? parsed.toISOString() : fallback;
}
function colour(value: unknown): [number, number, number] {
  const c = numbers(value).filter(Number.isFinite);
  if (c.length === 3) return [c[0], c[1], c[2]].map(v => Math.min(1, Math.max(0, v))) as [number, number, number];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) return [0, 1, 2].map(i => Math.min(1, Math.max(0, (1 - c[i]) * (1 - c[3])))) as [number, number, number];
  return [0.84, 0.18, 0.18];
}
function lineWidth(dict: PDFDict): number {
  const bs = dict.lookup(PDFName.of('BS'));
  const w = bs instanceof PDFDict ? bs.lookup(PDFName.of('W')) : undefined;
  const border = numbers(dict.lookup(PDFName.of('Border')));
  const value = w instanceof PDFNumber ? w.asNumber() : border.length >= 3 ? border[2] : 1;
  return Math.min(100, Math.max(0.25, Number.isFinite(value) ? value : 1));
}
const box = (r: number[]): [number, number][] => [[Math.min(r[0], r[2]), Math.min(r[1], r[3])], [Math.max(r[0], r[2]), Math.max(r[1], r[3])]];

/**
 * Converts standard markup annotations written by other PDF tools into editable OpenDraft
 * markups and returns a copy of the PDF with exactly those annotations (and their popups and
 * replies) removed, so saving cannot duplicate them. Unsupported annotations are left in place
 * and reported. Measurement annotations (/Measure) stay in the PDF untouched.
 */
export async function importForeignAnnotations(bytes: Uint8Array, now = new Date().toISOString()): Promise<ForeignImport> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica); // encoding check only; copy is saved separately
  const markups: Markup[] = [], skipped: SkippedAnnotation[] = [];
  const removeByPage = new Map<number, Set<PDFRef>>();
  const markupByRef = new Map<string, Markup>();
  const replies: { ref: PDFRef; parent: string; dict: PDFDict; pageIndex: number }[] = [];
  const encodable = (value: string) => { try { font.encodeText(value.replace(/\r?\n/g, '')); return true; } catch { return false; } };

  pdf.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const media = page.getMediaBox();
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i), dict = pdf.context.lookup(ref);
      if (!(ref instanceof PDFRef) || !(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(PDFName.of('Subtype'))?.toString().slice(1) ?? 'Unknown';
      if (IGNORED.has(subtype)) continue;
      const annotRef: PDFRef = ref, annotDict: PDFDict = dict;
      const nm = text(dict.lookup(PDFName.of('NM')));
      if (nm.startsWith('opendraft:')) continue; // already OpenDraft output; handled by its own model
      const irt = dict.get(PDFName.of('IRT'));
      if (irt instanceof PDFRef) { replies.push({ ref, parent: `${irt.objectNumber}:${irt.generationNumber}`, dict, pageIndex }); continue; }
      const skip = (reason: string) => skipped.push({ pageIndex, subtype, reason });
      if (!IMPORTABLE.has(subtype)) { skip('Annotation type has no editable OpenDraft equivalent; left unchanged.'); continue; }
      if (dict.has(PDFName.of('Measure')) || dict.lookup(PDFName.of('IT'))?.toString().includes('Dimension')) { skip('Measurement annotation; left unchanged (re-import of measurements is not supported).'); continue; }
      const rect = numbers(dict.lookup(PDFName.of('Rect')));
      if (rect.length !== 4 || rect.some(v => !Number.isFinite(v))) { skip('Missing or invalid /Rect.'); continue; }
      const contents = text(dict.lookup(PDFName.of('Contents'))).slice(0, 10000), author = text(dict.lookup(PDFName.of('T'))).slice(0, 200);
      if (!encodable(contents) || !encodable(author)) { skip('Text uses characters outside WinAnsi, which OpenDraft markups cannot yet write; left unchanged.'); continue; }
      const be = dict.lookup(PDFName.of('BE')), cloudy = be instanceof PDFDict && be.lookup(PDFName.of('S'))?.toString() === '/C';
      let kind: MarkupKind, points: [number, number][], stampName: StampName | undefined, callout: [number, number][] | undefined;
      if (subtype === 'Square') { kind = cloudy ? 'cloud' : 'rectangle'; points = box(rect); }
      else if (subtype === 'Circle') { kind = 'ellipse'; points = box(rect); }
      else if (subtype === 'Polygon') {
        if (!cloudy) { skip('Polygon outlines are not editable in OpenDraft; left unchanged.'); continue; }
        kind = 'cloud'; points = box(rect);
      } else if (subtype === 'Line') {
        const l = numbers(dict.lookup(PDFName.of('L')));
        if (l.length !== 4 || l.some(v => !Number.isFinite(v))) { skip('Line without valid /L.'); continue; }
        const endings = dict.lookup(PDFName.of('LE')), end = endings instanceof PDFArray ? endings.asArray().map(String) : [];
        kind = end.some(e => /Arrow/.test(e)) ? 'arrow' : 'line';
        // OpenDraft draws the arrowhead at the second point.
        points = /Arrow/.test(end[0] ?? '') && !/Arrow/.test(end[1] ?? '') ? [[l[2], l[3]], [l[0], l[1]]] : [[l[0], l[1]], [l[2], l[3]]];
      } else if (subtype === 'Ink') {
        const list = dict.lookup(PDFName.of('InkList'));
        const strokes = list instanceof PDFArray ? list.asArray().map(stroke => numbers(stroke instanceof PDFRef ? pdf.context.lookup(stroke) : stroke)) : [];
        const usable = strokes.filter(s => s.length >= 4 && s.length % 2 === 0 && s.every(Number.isFinite));
        if (!usable.length) { skip('Ink without usable strokes.'); continue; }
        if (usable.length > 1) skip(`Ink with ${usable.length} strokes imported as ${usable.length} separate ink markups.`);
        usable.slice(1).forEach((stroke, n) => queue('ink', stroke, n + 1));
        kind = 'ink'; points = pairs(usable[0]);
      } else if (subtype === 'Highlight') {
        const quads = numbers(dict.lookup(PDFName.of('QuadPoints')));
        const xs = quads.filter((_, i) => i % 2 === 0), ys = quads.filter((_, i) => i % 2 === 1);
        kind = 'highlight'; points = quads.length >= 8 && quads.every(Number.isFinite) ? [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]] : box(rect);
      } else if (subtype === 'FreeText') {
        const cl = numbers(dict.lookup(PDFName.of('CL'))), rd = numbers(dict.lookup(PDFName.of('RD')));
        const r = rd.length === 4 && rd.every(Number.isFinite) ? [rect[0] + rd[0], rect[1] + rd[1], rect[2] - rd[2], rect[3] - rd[3]] : rect;
        points = box(r);
        if ((cl.length === 4 || cl.length === 6) && cl.every(Number.isFinite)) { kind = 'callout'; callout = snapLeader(pairs(cl), points); }
        else kind = 'text';
      } else if (subtype === 'Text') {
        // Sticky notes become small text markups carrying the note so the comment is editable.
        kind = 'text'; points = [[rect[0], rect[1] - 18], [rect[0] + 180, rect[1]]];
      } else {
        const name = dict.lookup(PDFName.of('Name'))?.toString().slice(1) ?? '';
        kind = 'stamp'; points = box(rect); stampName = (STAMP_NAMES as readonly string[]).includes(name) ? name as StampName : 'Draft';
        if (stampName !== name && !contents) skip(`Custom stamp "${name || 'unnamed'}" imported as a text stamp; its original artwork is not preserved.`);
      }
      const id = `import-${pageIndex + 1}-${ref.objectNumber}-${ref.generationNumber}`;
      // A custom stamp keeps its name as visible text when it has no contents of its own.
      const stampLabel = subtype === 'Stamp' && !contents ? (dict.lookup(PDFName.of('Name'))?.toString().slice(1) ?? '').replace(/#20/g, ' ') : '';
      const label = stampLabel && stampLabel !== stampName && encodable(stampLabel) ? stampLabel : contents;
      const mark = build(id, pageIndex, kind, points, { contents: label, author, dict, stampName, callout });
      if (kind === 'text' || kind === 'callout') fitText(mark, font, media);
      const clamped = clampToPage(mark, media);
      if (!clamped) { skip('Annotation lies outside the page.'); continue; }
      markups.push(clamped); markupByRef.set(`${ref.objectNumber}:${ref.generationNumber}`, clamped);
      remove(pageIndex, ref, dict);

      function queue(k: MarkupKind, stroke: number[], n: number) {
        const extra = clampToPage(build(`import-${pageIndex + 1}-${annotRef.objectNumber}-${annotRef.generationNumber}-${n}`, pageIndex, k, pairs(stroke), { contents, author, dict: annotDict }), media);
        if (extra) markups.push(extra);
      }
    }
  });

  // Replies (/IRT) become threaded comments on the imported parent; orphans stay in the PDF.
  for (const reply of replies) {
    const parent = markupByRef.get(reply.parent);
    const contents = text(reply.dict.lookup(PDFName.of('Contents'))).trim(), author = text(reply.dict.lookup(PDFName.of('T'))).trim() || 'Unknown';
    if (!parent || !contents) { skipped.push({ pageIndex: reply.pageIndex, subtype: 'Reply', reason: parent ? 'Empty reply; left unchanged.' : 'Reply to an annotation that was not imported; left unchanged.' }); continue; }
    const at = pdfDate(text(reply.dict.lookup(PDFName.of('M'))) || text(reply.dict.lookup(PDFName.of('CreationDate'))), now);
    const comment: MarkupComment = { id: `reply-${reply.ref.objectNumber}-${reply.ref.generationNumber}`, author: author.slice(0, 200), contents: contents.slice(0, 10000), createdAt: at, modifiedAt: at };
    parent.comments = [...(parent.comments ?? []), comment];
    remove(reply.pageIndex, reply.ref, reply.dict);
  }

  // Remove from a fresh load so the encoding-check font embedded above is never written.
  const clean = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [pageIndex, refs] of removeByPage) {
    const annots = clean.getPage(pageIndex).node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) { const ref = annots.get(i); if (ref instanceof PDFRef && [...refs].some(r => r.objectNumber === ref.objectNumber && r.generationNumber === ref.generationNumber)) annots.remove(i); }
  }
  return { bytes: await clean.save({ useObjectStreams: false }), markups: validateMarkups(markups, pdf.getPageCount()), skipped };

  function remove(pageIndex: number, ref: PDFRef, dict: PDFDict) {
    const set = removeByPage.get(pageIndex) ?? new Set<PDFRef>(); set.add(ref);
    const popup = dict.get(PDFName.of('Popup')); if (popup instanceof PDFRef) set.add(popup);
    removeByPage.set(pageIndex, set);
  }
  function build(id: string, pageIndex: number, kind: MarkupKind, points: [number, number][], o: { contents: string; author: string; dict: PDFDict; stampName?: StampName; callout?: [number, number][] }): Markup {
    const created = pdfDate(text(o.dict.lookup(PDFName.of('CreationDate'))) || text(o.dict.lookup(PDFName.of('M'))), now);
    const modifiedRaw = pdfDate(text(o.dict.lookup(PDFName.of('M'))), created);
    const ca = o.dict.lookup(PDFName.of('CA'));
    return {
      id, pageIndex, kind, points, color: colour(o.dict.lookup(PDFName.of('C'))), width: lineWidth(o.dict),
      opacity: ca instanceof PDFNumber && Number.isFinite(ca.asNumber()) ? Math.min(1, Math.max(0, ca.asNumber())) : kind === 'highlight' ? 0.4 : 1,
      contents: o.contents, author: o.author, status: 'open', locked: false, createdAt: created, modifiedAt: Date.parse(modifiedRaw) < Date.parse(created) ? created : modifiedRaw,
      ...(o.stampName ? { stampName: o.stampName } : {}), ...(o.callout ? { callout: o.callout } : {}),
    };
  }
}

const pairs = (values: number[]): [number, number][] => Array.from({ length: values.length / 2 }, (_, i) => [values[2 * i], values[2 * i + 1]]);
/** OpenDraft requires the callout's last leader point on the text-box edge; move it to the nearest edge point. */
function snapLeader(leader: [number, number][], [[l, b], [r, t]]: [number, number][]): [number, number][] {
  const out = leader.map(p => [...p] as [number, number]), [x, y] = out[out.length - 1];
  const cx = Math.min(r, Math.max(l, x)), cy = Math.min(t, Math.max(b, y));
  const options: [number, number][] = [[l, cy], [r, cy], [cx, b], [cx, t]];
  out[out.length - 1] = options.reduce((best, p) => Math.hypot(p[0] - x, p[1] - y) < Math.hypot(best[0] - x, best[1] - y) ? p : best);
  return out.filter((p, i) => out.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i).length === out.length ? out : out.slice(-2);
}
function clampToPage(mark: Markup, media: { x: number; y: number; width: number; height: number }): Markup | undefined {
  const clamp = ([x, y]: [number, number]): [number, number] => [Math.min(media.x + media.width, Math.max(media.x, x)), Math.min(media.y + media.height, Math.max(media.y, y))];
  const points = mark.points.map(clamp), callout = mark.callout?.map(clamp);
  if (mark.kind !== 'ink' && (points[0][0] === points[1][0] || points[0][1] === points[1][1])) return undefined;
  return { ...mark, points, ...(callout ? { callout } : {}) };
}

/** OpenDraft writes notes at 12 pt; grow an imported box (keeping its top-left) until the note fits. */
function fitText(mark: Markup, font: { widthOfTextAtSize(text: string, size: number): number }, media: { y: number; height: number }) {
  let [[l, b], [r, t]] = mark.points;
  r = Math.max(r, l + 60);
  let lines = 0;
  for (const paragraph of mark.contents.split(/\r?\n/)) {
    let line = '';
    for (const character of paragraph) { if (font.widthOfTextAtSize(line + character, 12) > r - l - 8 && line) { lines++; line = ''; } line += character; }
    lines++;
  }
  const need = Math.max(16, lines * 14 + 6);
  if (t - b < need) { b = t - need; if (b < media.y) { b = media.y; t = Math.min(media.y + media.height, b + need); } }
  mark.points = [[l, b], [r, t]];
  if (mark.callout) mark.callout = snapLeader(mark.callout, mark.points);
}
