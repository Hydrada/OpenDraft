// Copies PDF.js runtime data (CMaps, standard fonts, WASM decoders, ICC profile) into the app's
// public folder so non-embedded fonts, CJK text and JPEG 2000/JBIG2 images render offline.
// Generated output is git-ignored; licenses travel with each folder.
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('node_modules/pdfjs-dist'), target = path.resolve('apps/opendraft/public/pdfjs');
await rm(target, { recursive: true, force: true });
// quickjs-eval runs PDF-embedded JavaScript; OpenDraft never executes PDF scripts, so it is not shipped.
const skip = (file) => /quickjs/i.test(path.basename(file));
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(path.join(source, folder), path.join(target, folder), { recursive: true, filter: file => !skip(file) });
console.log('PDF.js resources copied to apps/opendraft/public/pdfjs');

// OCR (Tesseract): worker, LSTM-only engine builds and the compact English model, served same-origin.
const ocr = path.resolve('apps/opendraft/public/ocr');
await rm(ocr, { recursive: true, force: true });
await cp(path.resolve('node_modules/tesseract.js/dist/worker.min.js'), path.join(ocr, 'worker.min.js'));
await cp(path.resolve('node_modules/tesseract.js/LICENSE.md'), path.join(ocr, 'tesseract.js-LICENSE.md')).catch(() => cp(path.resolve('node_modules/tesseract.js/LICENSE'), path.join(ocr, 'tesseract.js-LICENSE.txt')));
await cp(path.resolve('node_modules/tesseract.js-core'), path.join(ocr, 'core'), { recursive: true, filter: file => !/\.(md|json)$/i.test(file) && (!/tesseract-core/.test(path.basename(file)) || /-lstm\.wasm\.js$/.test(path.basename(file))) });
for (const language of ['eng', 'spa', 'fra', 'deu']) await cp(path.resolve(`node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`), path.join(ocr, 'lang', `${language}.traineddata.gz`));
console.log('OCR resources copied to apps/opendraft/public/ocr');
