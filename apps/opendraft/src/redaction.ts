import { PDFDocument, PDFName } from 'pdf-lib';

export type RedactionArea = { pageIndex: number; rect: [number, number, number, number] };
/** A full-page raster that already has every redaction box painted solid; size is in PDF points. */
export type RedactedRaster = { png: Uint8Array; width: number; height: number };

export function validateRedactions(areas: readonly RedactionArea[], pageCount: number): RedactionArea[] {
  if (!Array.isArray(areas) || areas.length > 2000) throw new Error('Redactions must be a list of at most 2,000 areas.');
  return areas.map(area => {
    const r = area?.rect;
    if (!Number.isInteger(area?.pageIndex) || area.pageIndex < 0 || area.pageIndex >= pageCount) throw new Error('Redaction refers to a missing page.');
    if (!Array.isArray(r) || r.length !== 4 || r.some(v => !Number.isFinite(v) || Math.abs(v) > 1e7)) throw new Error('Redaction area needs four finite coordinates.');
    const rect: [number, number, number, number] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    if (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) throw new Error('Redaction area must have positive width and height.');
    return { pageIndex: area.pageIndex, rect };
  });
}

/**
 * True redaction by replacement: every page that has a redaction area is rebuilt from a raster in
 * which the areas are already solid black, so no text, vector, image, annotation or form content
 * from that page survives underneath. Untouched pages are copied unchanged. Document-wide places
 * that can repeat page text (tagged structure, document JavaScript, metadata title/subject/keywords)
 * are cleared because they cannot be verified against the redacted areas.
 */
export async function buildRedactedPdf(bytes: Uint8Array, areas: readonly RedactionArea[], rasters: ReadonlyMap<number, RedactedRaster>): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const valid = validateRedactions(areas, source.getPageCount());
  const pages = new Set(valid.map(area => area.pageIndex));
  for (const index of pages) {
    const raster = rasters.get(index);
    if (!raster || !(raster.png instanceof Uint8Array) || !(raster.width > 0) || !(raster.height > 0)) throw new Error(`Page ${index + 1} has redactions but no rendered replacement.`);
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  // Only untouched pages are copied, so no object from a redacted page is ever written.
  const keep = source.getPageIndices().filter(index => !pages.has(index));
  const copied = new Map((await out.copyPages(source, keep)).map((page, n) => [keep[n], page]));
  for (let index = 0; index < source.getPageCount(); index++) {
    if (!pages.has(index)) { out.addPage(copied.get(index)!); continue; }
    const raster = rasters.get(index)!;
    const page = out.addPage([raster.width, raster.height]);
    const image = await out.embedPng(raster.png);
    page.drawImage(image, { x: 0, y: 0, width: raster.width, height: raster.height });
  }
  out.setTitle(''); out.setSubject(''); out.setKeywords([]);
  out.setProducer('OpenDraft redaction'); out.setCreator('OpenDraft');
  for (const key of ['StructTreeRoot', 'MarkInfo', 'Names', 'OpenAction', 'AA']) out.catalog.delete(PDFName.of(key));
  return out.save({ useObjectStreams: false });
}
