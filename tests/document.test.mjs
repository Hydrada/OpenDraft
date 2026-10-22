import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { drawingFixture } from './fixture.mjs';
import { normalizeRotation, exportPdf } from '../apps/opendraft/src/document.ts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'node:path';

test('quarter turns wrap including negative rotations; non-quarter edits fail', () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(810), 90);
  for (const value of [45, NaN, Infinity, 89.9]) assert.throws(() => normalizeRotation(value));
});

test('export applies deltas to existing rotations and preserves source bytes and page sizes', async () => {
  const source = await drawingFixture();
  const before = source.slice();
  const output = await exportPdf(source, new Map([[1, 90], [2, 270]]));
  const result = await PDFDocument.load(output);
  assert.equal(result.getPageCount(), 2);
  assert.deepEqual(result.getPages().map(page => page.getRotation().angle), [90, 0]);
  assert.deepEqual(result.getPages().map(page => page.getSize()), [{width:612,height:792},{width:792,height:612}]);
  assert.deepEqual(source, before);
  assert.deepEqual((await PDFDocument.load(source)).getPages().map(page => page.getRotation().angle), [0, 90]);
});

test('export rejects corrupt PDFs and invalid page edits', async () => {
  const source = await drawingFixture();
  for (const page of [0, 3, 1.5]) await assert.rejects(exportPdf(source, new Map([[page,90]])), /outside/);
  await assert.rejects(exportPdf(source, new Map([[1,45]])), /multiple/);
  await assert.rejects(exportPdf(new TextEncoder().encode('not a PDF'), new Map()));
});

test('direct rotation adapter refuses signature and XFA rewrites, including legacy recovery inputs', async () => {
  for (const kind of ['signature','xfa']) {
    const doc = await PDFDocument.create(); doc.addPage();
    if (kind === 'signature') {
      const signature = doc.context.register(doc.context.obj({Type:'Sig',ByteRange:[0,100,200,100],Contents:PDFHexString.of('00')}));
      doc.catalog.set(PDFName.of('Perms'),doc.context.obj({DocMDP:signature}));
    } else doc.catalog.set(PDFName.of('AcroForm'),doc.context.obj({XFA:PDFHexString.of('00')}));
    const bytes = await doc.save(), before = bytes.slice();
    await assert.rejects(exportPdf(bytes,new Map([[1,90]])),/signature|XFA/i);
    assert.deepEqual(bytes,before);
  }
});

test('independent PDF.js parser reads exported geometry, rotations and searchable text', async () => {
  const output = await exportPdf(await drawingFixture(), new Map([[1,90],[2,-90]]));
  const task = getDocument({data:output,isEvalSupported:false,standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/') + '/'});
  try {
    const parsed = await task.promise;
    assert.equal(parsed.numPages,2);
    for (const [number,rotation,text] of [[1,90,'OpenDraft synthetic drawing A101'],[2,0,'Valve schedule B202']]) {
      const page = await parsed.getPage(number);
      assert.equal(page.rotate,rotation);
      assert.ok((await page.getTextContent()).items.some(item=>item.str===text));
    }
  } finally { await task.destroy(); }
});
