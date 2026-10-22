import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFRef } from 'pdf-lib';

export type SheetProposal = { pageIndex: number; number: string; title: string; confidence: 'high' | 'medium' | 'low'; evidence: string; source: 'rules' | 'model' };
export type AcceptedSheet = { pageIndex: number; number: string; title: string };
export const SHEET_INDEX_LIMITS = Object.freeze({ pages: 500, textPerPage: 20_000, field: 200 });

const sheetNumber = /\b([A-Z]{1,3}[-.]?\d{1,4}(?:\.\d{1,3})?[A-Z]?)\b/gu;
const clean = (value: string) => value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();

const titleLike = (line: string) => line.length <= 80 && (line.match(/\p{L}/gu) ?? []).length >= 3
  && !/\b(scale|date|drawn|checked|approved|project\s+no|revision|rev\.?)\b/iu.test(line) && !/^[A-Z]{1,3}[-.]?\d{1,4}\b/u.test(line);

/**
 * Deterministic CPU engine (default). Proposes sheet number/title per page from extracted text.
 * Output is advisory: nothing is applied until a reviewer accepts specific rows.
 */
export function proposeSheetIndexRules(pages: readonly { pageIndex: number; text: string }[]): SheetProposal[] {
  if (!Array.isArray(pages) || pages.length > SHEET_INDEX_LIMITS.pages) throw new Error(`At most ${SHEET_INDEX_LIMITS.pages} pages can be indexed.`);
  const proposals: SheetProposal[] = [];
  for (const page of pages) {
    const lines: string[] = page.text.slice(0, SHEET_INDEX_LIMITS.textPerPage).split(/\r?\n/u).map(clean).filter(Boolean);
    const candidates: { number: string; line: string; index: number; score: number }[] = [];
    lines.forEach((line: string, index: number) => {
      for (const match of line.matchAll(sheetNumber)) {
        const number = match[1];
        if (!/\d/u.test(number)) continue;
        let score = 1;
        if (/\b(sheet|dwg|drawing\s+no|sheet\s+no)\b/iu.test(line)) score += 3;
        if (index >= lines.length - 3) score += 1; // title blocks usually come last in content order
        if (/^[A-Z]{1,2}-?\d{3}$/u.test(number)) score += 1;
        if (line === number) score += 1; // a line holding only the number is typical of title blocks
        candidates.push({ number, line, index, score });
      }
    });
    if (!candidates.length) continue;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0], tied = candidates.filter(item => item.score === best.score && item.number !== best.number).length > 0;
    let title = clean(best.line.replace(best.number, '').replace(/\b(sheet|dwg|no\.?)\b[:#]?/giu, ''));
    let evidence = best.line;
    if ((title.match(/\p{L}/gu) ?? []).length < 3) {
      // Title blocks usually put the title on the line after (or before) the sheet number.
      const neighbour = [lines[best.index + 1], lines[best.index - 1]].find(line => line !== undefined && titleLike(line));
      if (neighbour) { title = neighbour; evidence = `${best.line} / ${neighbour}`; }
    }
    proposals.push({
      pageIndex: page.pageIndex, number: best.number, title: title.slice(0, SHEET_INDEX_LIMITS.field),
      confidence: tied ? 'low' : best.score >= 4 ? 'high' : best.score >= 2 ? 'medium' : 'low',
      evidence: evidence.slice(0, SHEET_INDEX_LIMITS.field), source: 'rules',
    });
  }
  return proposals;
}

/** Strict schema for any engine output, including an untrusted model. */
export function validateSheetProposals(value: unknown, pageCount: number, source: SheetProposal['source']): SheetProposal[] {
  const list = (value as { sheets?: unknown } | null)?.sheets;
  if (!Array.isArray(list) || list.length > SHEET_INDEX_LIMITS.pages) throw new Error('Engine output must be {"sheets": [...]} with at most 500 rows.');
  const seen = new Set<number>();
  return list.flatMap((raw): SheetProposal[] => {
    const row = raw as Partial<SheetProposal> | null;
    if (!row || !Number.isInteger(row.pageIndex) || row.pageIndex! < 0 || row.pageIndex! >= pageCount || seen.has(row.pageIndex!) || typeof row.number !== 'string' || typeof row.title !== 'string') return [];
    const number = clean(row.number).slice(0, SHEET_INDEX_LIMITS.field), title = clean(row.title).slice(0, SHEET_INDEX_LIMITS.field);
    if (!number) return [];
    seen.add(row.pageIndex!);
    const confidence = row.confidence === 'high' || row.confidence === 'medium' ? row.confidence : 'low';
    return [{ pageIndex: row.pageIndex!, number, title, confidence, evidence: clean(String(row.evidence ?? '')).slice(0, SHEET_INDEX_LIMITS.field), source }];
  });
}

export function validateAccepted(rows: readonly AcceptedSheet[], pageCount: number): AcceptedSheet[] {
  const seen = new Set<number>();
  return rows.map(row => {
    const number = clean(row.number), title = clean(row.title);
    if (!Number.isInteger(row.pageIndex) || row.pageIndex < 0 || row.pageIndex >= pageCount || seen.has(row.pageIndex) || !number || number.length > SHEET_INDEX_LIMITS.field || title.length > SHEET_INDEX_LIMITS.field)
      throw new Error('Each accepted sheet needs a unique page, a sheet number and at most 200 characters per field.');
    seen.add(row.pageIndex);
    return { pageIndex: row.pageIndex, number, title };
  }).sort((a, b) => a.pageIndex - b.pageIndex);
}

export function sheetIndexCsv(rows: readonly AcceptedSheet[]): string {
  const cell = (value: string | number) => { const raw = String(value); return `"${(typeof value === 'string' && /^[\s]*[=+\-@]/u.test(raw) ? `'${raw}` : raw).replaceAll('"', '""')}"`; };
  return [['Page', 'Sheet number', 'Sheet title'], ...rows.map(row => [row.pageIndex + 1, row.number, row.title])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Copy with a "Sheet index" bookmark group appended after any existing outline items. */
export async function applySheetBookmarks(bytes: Uint8Array, accepted: readonly AcceptedSheet[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const rows = validateAccepted(accepted, pdf.getPageCount());
  if (!rows.length) throw new Error('Accept at least one sheet before exporting bookmarks.');
  const context = pdf.context, catalog = pdf.catalog;
  let outlines = catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (!outlines) { outlines = context.obj({ Type: 'Outlines', Count: 0 }); catalog.set(PDFName.of('Outlines'), context.register(outlines)); }
  const outlinesRef = catalog.get(PDFName.of('Outlines')) as PDFRef;
  const parentRef = context.nextRef(), childRefs = rows.map(() => context.nextRef());
  rows.forEach((row, index) => context.assign(childRefs[index], context.obj({
    Title: PDFHexString.fromText(row.title ? `${row.number} — ${row.title}` : row.number), Parent: parentRef,
    Dest: [pdf.getPage(row.pageIndex).ref, PDFName.of('Fit')],
    ...(index ? { Prev: childRefs[index - 1] } : {}), ...(index < rows.length - 1 ? { Next: childRefs[index + 1] } : {}),
  })));
  const last = outlines.get(PDFName.of('Last')) as PDFRef | undefined;
  context.assign(parentRef, context.obj({ Title: PDFHexString.fromText('Sheet index (reviewed)'), Parent: outlinesRef, First: childRefs[0], Last: childRefs.at(-1)!, Count: rows.length, ...(last ? { Prev: last } : {}) }));
  if (last) context.lookup(last, PDFDict).set(PDFName.of('Next'), parentRef); else outlines.set(PDFName.of('First'), parentRef);
  outlines.set(PDFName.of('Last'), parentRef);
  const count = outlines.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber() ?? 0;
  outlines.set(PDFName.of('Count'), PDFNumber.of(Math.abs(count) + 1 + rows.length));
  return pdf.save({ useObjectStreams: false });
}
