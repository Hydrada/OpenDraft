import { PDFDocument, type PDFOperator, StandardFonts, TextRenderingMode, beginText, endText, popGraphicsState, pushGraphicsState, setCharacterSqueeze, setFontAndSize, setTextMatrix, setTextRenderingMode, showText } from 'pdf-lib';

/** A recognized word in PDF user space (unrotated), lower-left origin. */
/** x,y is the word's baseline-left corner; angle (radians) follows the text direction in PDF space. */
export type OcrWord = { text: string; x: number; y: number; width: number; height: number; confidence: number; angle?: number };
export type OcrPage = { pageIndex: number; words: OcrWord[] };

/**
 * Makes a scanned PDF searchable: each recognized word is written as invisible text (render mode 3)
 * over its position, so selection and search find it while the page looks unchanged. Words below
 * `minConfidence` are skipped; characters outside WinAnsi become "?".
 */
export async function applyOcrTextLayer(bytes: Uint8Array, pages: readonly OcrPage[], { minConfidence = 40 } = {}): Promise<{ bytes: Uint8Array; words: number }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let written = 0;
  for (const { pageIndex, words } of pages) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.getPageCount()) throw new Error('OCR result refers to a missing page.');
    const page = pdf.getPage(pageIndex), key = page.node.newFontDictionary('OpenDraftOCR', font.ref);
    const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const word of words) {
      const clean = word.text.normalize('NFC').replace(/[^\x20-\x7e -ÿ]/g, '?').trim();
      if (!clean || word.confidence < minConfidence || !(word.width > 0) || !(word.height > 0) || ![word.x, word.y].every(Number.isFinite)) continue;
      const size = Math.max(1, word.height), natural = font.widthOfTextAtSize(clean, size);
      // Horizontal scaling stretches the text so selection boxes match the word on the scan.
      const scale = natural > 0 ? Math.min(1000, Math.max(1, (word.width / natural) * 100)) : 100;
      ops.push(setFontAndSize(key, size), setCharacterSqueeze(scale), setTextMatrix(Math.cos(word.angle ?? 0), Math.sin(word.angle ?? 0), -Math.sin(word.angle ?? 0), Math.cos(word.angle ?? 0), word.x - Math.sin(word.angle ?? 0) * word.height * 0.18, word.y + Math.cos(word.angle ?? 0) * word.height * 0.18), showText(font.encodeText(clean)));
      written++;
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
  pdf.setProducer('OpenDraft OCR');
  return { bytes: await pdf.save(), words: written };
}

/** Converts Tesseract pixel boxes on a page raster to PDF user-space words. */
export function wordsFromPixels(words: readonly { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[], raster: { width: number; height: number }, page: { width: number; height: number; x?: number; y?: number }): OcrWord[] {
  const sx = page.width / raster.width, sy = page.height / raster.height;
  return words.map(word => ({
    text: word.text, confidence: word.confidence,
    x: (page.x ?? 0) + word.bbox.x0 * sx, y: (page.y ?? 0) + page.height - word.bbox.y1 * sy,
    width: (word.bbox.x1 - word.bbox.x0) * sx, height: (word.bbox.y1 - word.bbox.y0) * sy,
  }));
}
