import { PDFArray, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { measure, spaceOf } from './measurements.ts';
import { derivedQuantity, validateTakeoff, type TakeoffState } from './takeoff.ts';

export type LegendRow = { space: string; label: string; kind: string; count: number; total: number; unit: string; derived?: { total: number; unit: string } };

/** Groups measurements by label, type and unit and totals them (derived quantities likewise). Pages limit the scope. */
export function legendRows(input: TakeoffState, pageCount: number, pages?: readonly number[]): LegendRow[] {
  const state = validateTakeoff(input, pageCount), rows = new Map<string, LegendRow>();
  for (const record of state.records) {
    if (pages && !pages.includes(record.pageIndex)) continue;
    const result = measure({ ...record, scales: state.scales }), derived = derivedQuantity(record, result.value);
    const space = spaceOf(record, state.records)?.label ?? '';
    const key = JSON.stringify([space, record.label, record.kind, result.unit, record.quantity?.unitLabel ?? null]);
    const row = rows.get(key) ?? { space, label: record.label, kind: record.kind, count: 0, total: 0, unit: result.unit };
    row.count++; row.total += result.value;
    if (derived !== undefined) row.derived = { total: (row.derived?.total ?? 0) + derived, unit: record.quantity?.unitLabel || 'units' };
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.space.localeCompare(b.space) || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
}

const format = (value: number) => { const rounded = Math.round(value * 100) / 100; return rounded.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2 }); };

/**
 * Writes a copy with the legend drawn as a FreeText annotation whose appearance is a table, so it
 * prints and can still be moved or deleted in any viewer. Text outside WinAnsi is replaced by "?".
 */
export async function applyTakeoffLegend(bytes: Uint8Array, rows: readonly LegendRow[], pageIndex: number, origin?: [number, number], title = 'Takeoff legend'): Promise<Uint8Array> {
  if (!rows.length) throw new Error('There are no measurements to summarise.');
  if (rows.length > 200) throw new Error('A legend can list at most 200 rows.');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.getPageCount()) throw new Error('Legend page does not exist.');
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (text: string) => { const clean = text.replace(/[\r\n\t]+/g, ' ').slice(0, 80); try { font.encodeText(clean); return clean; } catch { return clean.replace(/[^\x20-\x7e]/g, '?'); } };
  const size = 9, rowHeight = 13, pad = 5;
  // The Space column appears only when some measurement lies in a named space.
  const spaced = rows.some(row => row.space);
  const header = [...(spaced ? ['Space'] : []), 'Item', 'Type', 'Qty', 'Total', 'Derived'];
  const cells = rows.map(row => [...(spaced ? [safe(row.space)] : []), safe(row.label), row.kind, String(row.count), `${format(row.total)} ${row.unit}`, row.derived ? `${format(row.derived.total)} ${safe(row.derived.unit)}` : '']);
  const widths = header.map((h, c) => Math.max(bold.widthOfTextAtSize(h, size), ...cells.map(r => font.widthOfTextAtSize(r[c], size))) + pad * 2);
  const width = widths.reduce((a, b) => a + b, 0), height = rowHeight * (rows.length + 2) + pad;
  const page = pdf.getPage(pageIndex), box = page.getMediaBox();
  // Default: top-left corner, 36 pt in from the page edges.
  const [x, top] = origin ?? [box.x + 36, box.y + box.height - 36], y = top - height;
  if (x < box.x || y < box.y || x + width > box.x + box.width || top > box.y + box.height) throw new Error(`The legend (${Math.ceil(width)} x ${Math.ceil(height)} pt) does not fit on the page at that position.`);
  const text = (f: typeof font, s: string, tx: number, ty: number) => `BT /${f === bold ? 'F1' : 'F0'} ${size} Tf 1 0 0 1 ${tx.toFixed(2)} ${ty.toFixed(2)} Tm ${f.encodeText(s).toString()} Tj ET`;
  const ops = ['q 1 1 1 rg 0 0 ' + width + ' ' + height + ' re f 0.1 0.25 0.45 RG 0.8 w 0.4 0.4 ' + (width - 0.8) + ' ' + (height - 0.8) + ' re S', '0 0 0 rg'];
  ops.push(text(bold, safe(title), pad, height - rowHeight + 2));
  let cx = 0; header.forEach((h, c) => { ops.push(text(bold, h, cx + pad, height - rowHeight * 2 + 3)); cx += widths[c]; });
  ops.push(`0.6 0.6 0.6 RG 0.5 w 0 ${(height - rowHeight * 2 - 1).toFixed(2)} m ${width} ${(height - rowHeight * 2 - 1).toFixed(2)} l S`);
  cells.forEach((row, r) => { let rx = 0; row.forEach((cell, c) => { ops.push(text(font, cell, rx + pad, height - rowHeight * (r + 3) + 3)); rx += widths[c]; }); });
  ops.push('Q');
  const appearance = pdf.context.register(pdf.context.flateStream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: { Font: { F0: font.ref, F1: bold.ref } } }));
  const summary = [title, ...cells.map(r => r.filter(Boolean).join(' | '))].join('\n');
  const annotation = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'FreeText', Rect: [x, y, x + width, top], Contents: PDFHexString.fromText(summary), DA: '/Helv 9 Tf 0 g',
    NM: PDFHexString.fromText(`opendraft-legend:${Date.now()}`), F: 4, AP: { N: appearance }, T: PDFHexString.fromText('OpenDraft takeoff'),
  }));
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(annotation); else page.node.set(PDFName.of('Annots'), pdf.context.obj([annotation]));
  return pdf.save();
}
