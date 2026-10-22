import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { applyMarkups, validateMarkups } from '../apps/opendraft/src/annotations.ts';

function png(width, height) {
  const crc = buffer => { let c = ~0; for (const byte of buffer) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height, 0x40))), chunk('IEND', Buffer.alloc(0))]);
}
const at = '2026-10-22T00:00:00.000Z';
const stamp = (image, extra = {}) => ({ id: 'seal', pageIndex: 0, kind: 'stamp', stampName: 'Approved', points: [[100, 100], [300, 200]], image, color: [0.8, 0, 0], width: 2, opacity: 1, contents: '', author: 'PE', status: 'open', locked: false, createdAt: at, modifiedAt: at, ...extra });

test('image stamps embed their artwork, fitted and centred, in a standard Stamp appearance', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 300]);
  const image = { format: 'png', data: png(40, 10).toString('base64') };
  const saved = await PDFDocument.load(await applyMarkups(await pdf.save(), [stamp(image), stamp(image, { id: 'seal2', points: [[10, 10], [60, 60]] })]));
  const annots = saved.getPage(0).node.Annots().asArray().map(ref => saved.context.lookup(ref));
  assert.deepEqual(annots.map(a => String(a.lookup(PDFName.of('Subtype')))), ['/Stamp', '/Stamp']);
  const ap = annots[0].lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
  const xobject = ap.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('XObject')).lookup(PDFName.of('Im0'));
  assert.equal(String(xobject.dict.lookup(PDFName.of('Subtype'))), '/Image');
  assert.equal(xobject.dict.lookup(PDFName.of('Width')).asNumber(), 40);
  // 200x100 box, 4:1 image → 200x50, centred vertically (25 below + pad).
  const content = Buffer.from((await import('pdf-lib')).decodePDFRawStream(ap).decode()).toString('latin1');
  assert.match(content, /q 200 0 0 50 \d+(\.\d+)? \d+(\.\d+)? cm \/Im0 Do Q/);
  // Identical artwork is embedded once and shared.
  const images = saved.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && String(o.dict.lookup(PDFName.of('Subtype'))) === '/Image');
  assert.equal(images.length, 1);
});

test('image data is validated: format, signature, size and kind', () => {
  const good = { format: 'png', data: png(2, 2).toString('base64') };
  assert.equal(validateMarkups([stamp(good)], 1)[0].image.format, 'png');
  assert.throws(() => validateMarkups([stamp({ format: 'jpeg', data: good.data })], 1), /does not match/);
  assert.throws(() => validateMarkups([stamp({ format: 'gif', data: good.data })], 1), /PNG, JPEG or PDF/);
  assert.throws(() => validateMarkups([stamp({ format: 'png', data: 'A'.repeat(2_800_004) })], 1), /2 MB/);
  assert.throws(() => validateMarkups([{ ...stamp(good), kind: 'rectangle', stampName: undefined }], 1), /only on stamps/);
});

test('page 1 of a PDF can be stamp artwork, embedded as vector content', async () => {
  const art = await PDFDocument.create(); art.addPage([200, 100]).drawRectangle({ x: 10, y: 10, width: 180, height: 80, borderWidth: 4 });
  const data = Buffer.from(await art.save()).toString('base64');
  const pdf = await PDFDocument.create(); pdf.addPage([400, 300]);
  const saved = await PDFDocument.load(await applyMarkups(await pdf.save(), [stamp({ format: 'pdf', data })]));
  const [annot] = saved.getPage(0).node.Annots().asArray().map(ref => saved.context.lookup(ref));
  const xobject = annot.lookup(PDFName.of('AP')).lookup(PDFName.of('N')).dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('XObject')).lookup(PDFName.of('Im0'));
  assert.equal(String(xobject.dict.lookup(PDFName.of('Subtype'))), '/Form');
  assert.throws(() => validateMarkups([stamp({ format: 'pdf', data: png(2, 2).toString('base64') })], 1), /does not match/);
});
