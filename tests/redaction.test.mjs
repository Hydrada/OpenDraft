import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildRedactedPdf, validateRedactions } from '../apps/opendraft/src/redaction.ts';

// Minimal valid black RGB PNG (test stand-in for the browser-rendered page raster).
function png(width, height) {
  const crc = buffer => { let c = ~0; for (const byte of buffer) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
async function source() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle('Account 1234 drawing');
  const secret = pdf.addPage([400, 300]); secret.drawText('SECRET ACCOUNT 1234', { x: 40, y: 200, size: 18, font }); secret.drawText('GRID A', { x: 40, y: 40, size: 12, font });
  secret.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 20, 20], Contents: 'leak' }))]));
  pdf.addPage([400, 300]).drawText('PUBLIC SHEET', { x: 40, y: 200, size: 18, font });
  return pdf.save();
}
const texts = async bytes => { const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise; const out = []; for (let n = 1; n <= doc.numPages; n++) out.push((await (await doc.getPage(n)).getTextContent()).items.map(item => item.str).join(' ').trim()); await doc.cleanup(); return out; };

test('redacted pages are replaced by their raster; no text, annotations or title survive', async () => {
  const before = await source();
  assert.match((await texts(before))[0], /SECRET ACCOUNT 1234/);
  const result = await buildRedactedPdf(before, [{ pageIndex: 0, rect: [30, 190, 300, 220] }], new Map([[0, { png: png(8, 6), width: 400, height: 300 }]]));
  const [page1, page2] = await texts(result);
  assert.equal(page1, ''); // the whole page is now an image: nothing searchable or extractable remains
  assert.match(page2, /PUBLIC SHEET/);
  const doc = await PDFDocument.load(result);
  assert.equal(doc.getPage(0).node.Annots()?.size() ?? 0, 0);
  assert.deepEqual([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()], [400, 300]);
  assert.equal(doc.getTitle() ?? '', '');
  // Decode every stream in the file: the secret must not survive anywhere, even unreferenced.
  const decoded = doc.context.enumerateIndirectObjects().map(([, object]) => object instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(object).decode()).toString('latin1') : String(object));
  assert.ok(!decoded.some(text => /SECRET|ACCOUNT|1234|leak/.test(text)));
});

test('redaction input is validated and every redacted page needs a raster', async () => {
  assert.throws(() => validateRedactions([{ pageIndex: 3, rect: [0, 0, 1, 1] }], 2), /missing page/);
  assert.throws(() => validateRedactions([{ pageIndex: 0, rect: [0, 0, 0, 5] }], 2), /positive/);
  assert.deepEqual(validateRedactions([{ pageIndex: 0, rect: [9, 9, 1, 1] }], 1), [{ pageIndex: 0, rect: [1, 1, 9, 9] }]);
  await assert.rejects(buildRedactedPdf(await source(), [{ pageIndex: 1, rect: [0, 0, 5, 5] }], new Map()), /no rendered replacement/);
});
