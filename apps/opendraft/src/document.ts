import { PDFDocument, degrees } from 'pdf-lib';
import { assertEditablePdf } from './document-safety.ts';

/** PDF rotations are clockwise quarter turns. Reject invalid edits rather than rounding. */
export function normalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new Error('Rotation must be a multiple of 90 degrees.');
  return ((rotation % 360) + 360) % 360;
}

/** Keys are one-based page numbers; values are clockwise deltas from the source. */
export async function exportPdf(bytes: Uint8Array, rotations: ReadonlyMap<number, number>): Promise<Uint8Array> {
  // Also protect legacy recovery and direct adapter callers, not just UI edits.
  await assertEditablePdf(bytes);
  const document = await PDFDocument.load(bytes, {updateMetadata:false});
  for (const [pageNumber, delta] of rotations) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) throw new Error('Page number is outside the document.');
    const page = document.getPage(pageNumber - 1);
    page.setRotation(degrees(normalizeRotation(page.getRotation().angle + delta)));
  }
  return document.save();
}
