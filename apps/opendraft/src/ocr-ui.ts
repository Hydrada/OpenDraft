import type { PDFDocumentProxy } from 'pdfjs-dist';
import { applyOcrTextLayer, type OcrPage, type OcrWord } from './ocr-text';

type Options = {
  document: () => { name: string; bytes: Uint8Array; pdf: PDFDocumentProxy; pageIndex: number } | undefined;
  open: (bytes: Uint8Array, name: string) => Promise<void>;
  error: (message: string) => void;
};
const base = `${import.meta.env.BASE_URL}ocr/`, MAX_PIXELS = 25_000_000, TARGET_DPI = 300;

/**
 * OCR panel (Tesseract, English, fully offline). Recognized words are added as invisible text in a
 * copy opened in a new tab, so search, selection and the sheet-index assistant work on scans.
 */
export function mountOcr(container: HTMLElement, options: Options) {
  container.innerHTML = '<h3>Text recognition (OCR)</h3><p>Makes scanned drawings searchable. Runs on this computer; nothing is uploaded. The result opens as a copy in a new tab. Accuracy depends on scan quality.</p>';
  const languageRow = document.createElement('label'); languageRow.textContent = 'OCR language';
  const language = document.createElement('select'); language.setAttribute('aria-label', 'OCR language');
  for (const [value, text] of [['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['eng+spa', 'English + Spanish'], ['eng+fra', 'English + French'], ['eng+deu', 'English + German']]) language.append(new Option(text, value));
  languageRow.append(language); container.append(languageRow);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'OCR status');
  const button = (label: string, all: boolean) => {
    const element = document.createElement('button'); element.textContent = label;
    element.onclick = async () => {
      const doc = options.document(); if (!doc) { status.textContent = 'Open a PDF first.'; return; }
      for (const item of container.querySelectorAll('button')) (item as HTMLButtonElement).disabled = true;
      try {
        const pages = all ? Array.from({ length: Math.min(doc.pdf.numPages, 200) }, (_, i) => i) : [doc.pageIndex];
        const results = await recognize(doc.pdf, pages, language.value, text => { status.textContent = text; });
        const { bytes, words } = await applyOcrTextLayer(doc.bytes, results);
        await options.open(bytes, `${doc.name.replace(/\.pdf$/i, '')} (OCR).pdf`);
        status.textContent = `Recognized ${words} word(s) on ${pages.length} page(s); opened a searchable copy.`;
      } catch (e) { const message = `OCR failed: ${e instanceof Error ? e.message : String(e)}`; status.textContent = message; options.error(message); }
      finally { for (const item of container.querySelectorAll('button')) (item as HTMLButtonElement).disabled = false; }
    };
    container.append(element);
  };
  button('Recognize text on current page', false);
  button('Recognize text on all pages', true);
  container.append(status);
}

async function recognize(pdf: PDFDocumentProxy, pageIndexes: number[], languages: string, progress: (text: string) => void): Promise<OcrPage[]> {
  if (!/^(eng|spa|fra|deu)(\+(eng|spa|fra|deu))*$/.test(languages)) throw new Error('Unsupported OCR language.');
  progress('Loading the OCR engine…');
  const { createWorker, OEM } = await import('tesseract.js');
  const worker = await createWorker(languages, OEM.LSTM_ONLY, { workerPath: `${base}worker.min.js`, corePath: `${base}core`, langPath: `${base}lang`, gzip: true, workerBlobURL: false, cacheMethod: 'none' });
  try {
    const out: OcrPage[] = [];
    for (const [n, pageIndex] of pageIndexes.entries()) {
      progress(`Recognizing page ${pageIndex + 1} (${n + 1} of ${pageIndexes.length})…`);
      const page = await pdf.getPage(pageIndex + 1), unit = page.getViewport({ scale: 1 });
      const scale = Math.min(TARGET_DPI / 72, Math.sqrt(MAX_PIXELS / (unit.width * unit.height)));
      const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false })!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const words: OcrWord[] = [];
      for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) for (const word of line.words) {
        // Map the upright pixel box back to PDF space; on rotated pages the text runs at an angle.
        const toPdf = (x: number, y: number) => viewport.convertToPdfPoint(x, y) as [number, number];
        const origin = toPdf(word.bbox.x0, word.bbox.y1), right = toPdf(word.bbox.x1, word.bbox.y1), top = toPdf(word.bbox.x0, word.bbox.y0);
        words.push({ text: word.text, confidence: word.confidence, x: origin[0], y: origin[1], width: Math.hypot(right[0] - origin[0], right[1] - origin[1]), height: Math.hypot(top[0] - origin[0], top[1] - origin[1]), angle: Math.atan2(right[1] - origin[1], right[0] - origin[0]) });
      }
      out.push({ pageIndex, words });
      canvas.width = canvas.height = 0; page.cleanup();
    }
    return out;
  } finally { await worker.terminate(); }
}
