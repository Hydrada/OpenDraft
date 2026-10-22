import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyOcrTextLayer, wordsFromPixels } from '../apps/opendraft/src/ocr-text.ts';

test('pixel boxes map to PDF space with a lower-left origin', () => {
  const [word] = wordsFromPixels([{ text: 'VALVE', confidence: 91, bbox: { x0: 100, y0: 50, x1: 300, y1: 90 } }], { width: 1000, height: 500 }, { width: 500, height: 250 });
  assert.deepEqual(word, { text: 'VALVE', confidence: 91, x: 50, y: 205, width: 100, height: 20 });
});

test('invisible OCR text becomes searchable at the recognized positions; low-confidence words are skipped', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  const { bytes, words } = await applyOcrTextLayer(await pdf.save(), [{ pageIndex: 0, words: [
    { text: 'VALVE', confidence: 92, x: 100, y: 300, width: 80, height: 14 }, { text: 'ROOM', confidence: 88, x: 190, y: 300, width: 60, height: 14 },
    { text: 'smudge', confidence: 12, x: 10, y: 10, width: 40, height: 10 }, { text: 'Café', confidence: 90, x: 300, y: 100, width: 50, height: 12 },
  ] }]);
  assert.equal(words, 3);
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const items = (await (await doc.getPage(1)).getTextContent()).items.filter(item => item.str.trim());
  // Words on one line are joined by pdf.js into a searchable phrase.
  assert.deepEqual(items.map(item => item.str), ['VALVE ROOM', 'Café']);
  const valve = items[0];
  assert.ok(Math.abs(valve.transform[4] - 100) < 0.5, `x ${valve.transform[4]}`);
  assert.ok(Math.abs(valve.width - 150) < 2, `phrase spans 100..250, width ${valve.width}`);
  await doc.cleanup();
  await assert.rejects(applyOcrTextLayer(await pdf.save(), [{ pageIndex: 3, words: [] }]), /missing page/);
});
