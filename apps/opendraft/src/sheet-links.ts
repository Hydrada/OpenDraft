import { PDFArray, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import type { AcceptedSheet } from './ai-sheet-index.ts';

export type TextRun = { str: string; rect: [number, number, number, number] };
export type SheetLink = { pageIndex: number; rect: [number, number, number, number]; target: number; number: string };
export const SHEET_LINK_LIMIT = 20_000;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "A-101", "A101" and "A.101" are written interchangeably on drawings. */
const flexible = (number: string) => escape(number.replace(/[-.\s]/g, '')).replace(/(?<=[A-Za-z])(?=\d)/g, '[-.]?');

/**
 * Finds references to reviewed sheet numbers in page text runs ("SEE A-102", detail "3/A102") on
 * pages other than the sheet itself. The run's box is used for the link, so the clickable area is
 * the whole run containing the reference. Pure and deterministic.
 */
export function findSheetReferences(pages: readonly { pageIndex: number; runs: readonly TextRun[] }[], sheets: readonly AcceptedSheet[]): SheetLink[] {
  const patterns = sheets.filter(sheet => sheet.number.trim()).map(sheet => ({ sheet, pattern: new RegExp(`(?<![A-Za-z0-9])${flexible(sheet.number.trim())}(?![A-Za-z0-9])`, 'i') }));
  const links: SheetLink[] = [];
  for (const page of pages) for (const run of page.runs) {
    if (links.length >= SHEET_LINK_LIMIT) return links;
    const match = patterns.find(({ sheet, pattern }) => sheet.pageIndex !== page.pageIndex && pattern.test(run.str));
    if (match && run.rect.every(Number.isFinite) && run.rect[2] > run.rect[0] && run.rect[3] > run.rect[1])
      links.push({ pageIndex: page.pageIndex, rect: run.rect, target: match.sheet.pageIndex, number: match.sheet.number });
  }
  return links;
}

/** Writes standard /Link annotations with /GoTo destinations into a copy; existing links are kept. */
export async function applySheetLinks(bytes: Uint8Array, links: readonly SheetLink[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false }), count = pdf.getPageCount();
  if (links.length > SHEET_LINK_LIMIT) throw new Error(`At most ${SHEET_LINK_LIMIT} sheet links can be written.`);
  for (const link of links) {
    if (![link.pageIndex, link.target].every(index => Number.isInteger(index) && index >= 0 && index < count)) throw new Error('Sheet link refers to a missing page.');
    const page = pdf.getPage(link.pageIndex), target = pdf.getPage(link.target);
    const annotation = pdf.context.register(pdf.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: link.rect, Border: [0, 0, 0], H: 'I',
      Contents: PDFHexString.fromText(`Go to sheet ${link.number}`),
      A: pdf.context.obj({ S: 'GoTo', D: [target.ref, PDFName.of('Fit')] }),
    }));
    const annots = page.node.Annots();
    if (annots instanceof PDFArray) annots.push(annotation); else page.node.set(PDFName.of('Annots'), pdf.context.obj([annotation]));
  }
  return pdf.save();
}
