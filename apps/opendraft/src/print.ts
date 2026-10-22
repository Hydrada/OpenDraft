import type { PDFDocumentProxy } from 'pdfjs-dist';

type OptionalConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
export type PreparedPrint = { print: () => void; dispose: () => void; dpi: number };
export const PRINT_LIMITS = Object.freeze({ pages: 300, targetDpi: 200, minimumDpi: 100, pagePixels: 40_000_000, totalPixels: 600_000_000 });

/**
 * Prepare all pages locally for printing. Each page is rendered once, encoded as a PNG image and its
 * canvas released, so memory stays bounded. Resolution targets 200 dpi and is lowered uniformly
 * (never below 100 dpi) for large sets; a single oversized sheet is capped at 40 million pixels.
 * This is rasterized printing, not original-vector or colour-managed output. Preparing never
 * opens the print dialog; the caller owns disposal.
 */
export async function preparePrint(pdf: PDFDocumentProxy, optionalContentConfig?: OptionalConfig): Promise<PreparedPrint> {
  if (document.getElementById('opendraft-print-root')) throw new Error('Close the existing print preview before preparing another.');
  if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > PRINT_LIMITS.pages) throw new Error(`Printing supports 1–${PRINT_LIMITS.pages} pages. Extract a smaller set to print.`);
  const pages: { page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>; width: number; height: number }[] = [];
  let area = 0; // square points at 72 dpi
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
    if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error(`Page ${number} has an invalid size.`);
    area += viewport.width * viewport.height;
    pages.push({ page, width: viewport.width, height: viewport.height });
  }
  // One uniform resolution for the set, within the total budget.
  const dpi = Math.min(PRINT_LIMITS.targetDpi, Math.floor(72 * Math.sqrt(PRINT_LIMITS.totalPixels / area)));
  if (dpi < PRINT_LIMITS.minimumDpi) throw new Error(`The set is too large to print at ${PRINT_LIMITS.minimumDpi} dpi or better. Extract fewer pages to print.`);
  const root = document.createElement('section');
  root.id = 'opendraft-print-root';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', `Print preview — rasterized at ${dpi} dpi`);
  const style = document.createElement('style');
  style.dataset.opendraftPrint = 'true';
  const rules = ['#opendraft-print-root { display:none; }', '@media print { html, body { margin:0!important; padding:0!important; width:auto!important; height:auto!important; overflow:visible!important; background:white!important; } body > :not(#opendraft-print-root) { display:none!important; } #opendraft-print-root { display:block!important; margin:0!important; padding:0!important; } #opendraft-print-root img { display:block; margin:0; padding:0; } #opendraft-print-root .opendraft-print-page { margin:0; padding:0; overflow:hidden; break-after:page; break-inside:avoid; } #opendraft-print-root .opendraft-print-page:last-child { break-after:auto; } }'];
  const urls: string[] = [];
  try {
    // Display configs cannot be passed directly to PDF.js's print render intent.
    // Copy the chosen visibility into a print-intent config without mutating UI state.
    const printConfig = optionalContentConfig ? await pdf.getOptionalContentConfig({ intent: 'print' }) : undefined;
    if (printConfig && optionalContentConfig) {
      for (const [id, group] of optionalContentConfig) if (printConfig.getGroup(id)) printConfig.setVisibility(id, Boolean(group.visible), false);
    }
    for (let index = 0; index < pages.length; index++) {
      const { page, width, height } = pages[index];
      const scale = Math.min(dpi / 72, Math.sqrt(PRINT_LIMITS.pagePixels / (width * height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false })!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport, intent: 'print', optionalContentConfigPromise: printConfig ? Promise.resolve(printConfig) : undefined }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(`Page ${index + 1} could not be encoded for printing.`)), 'image/png'));
      canvas.width = canvas.height = 0; page.cleanup();
      const url = URL.createObjectURL(blob); urls.push(url);
      const image = document.createElement('img');
      image.src = url; image.alt = `Print page ${index + 1}`; image.decoding = 'async';
      image.dataset.pixels = `${Math.ceil(viewport.width)}x${Math.ceil(viewport.height)}`;
      image.style.width = `${width}pt`; image.style.height = `${height}pt`;
      const sheet = document.createElement('div');
      sheet.className = 'opendraft-print-page';
      sheet.style.width = `${width}pt`; sheet.style.height = `${height}pt`;
      sheet.style.page = `opendraft-sheet-${index}`;
      sheet.append(image); root.append(sheet);
      rules.push(`@page opendraft-sheet-${index} { size:${width}pt ${height}pt; margin:0; }`);
    }
    // Recheck after asynchronous preparation to avoid two concurrent previews.
    if (document.getElementById('opendraft-print-root')) throw new Error('Another print preview was prepared.');
    style.textContent = rules.join('\n');
    document.head.append(style); document.body.append(root);
    // Wait until every page image is decoded so the print dialog never shows blank pages.
    await Promise.all(Array.from(root.querySelectorAll('img'), image => image.decode().catch(() => undefined)));
  } catch (error) {
    urls.forEach(url => URL.revokeObjectURL(url));
    root.remove(); style.remove(); throw error;
  }
  let disposed = false;
  return {
    dpi,
    print() { if (disposed || !root.isConnected) throw new Error('Print preview has been disposed.'); window.print(); },
    dispose() { if (disposed) return; disposed = true; urls.forEach(url => URL.revokeObjectURL(url)); root.remove(); style.remove(); },
  };
}
