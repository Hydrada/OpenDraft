import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applySheetLinks, findSheetReferences } from '../apps/opendraft/src/sheet-links.ts';

const sheets = [{ pageIndex: 0, number: 'A101', title: 'Plan' }, { pageIndex: 1, number: 'A-102', title: 'Elevations' }, { pageIndex: 2, number: 'M201', title: 'Mech' }];
const run = (str, x = 10) => ({ str, rect: [x, 10, x + 50, 22] });

test('references to other sheets are found with flexible separators; self, partial and unknown references are not', () => {
  const links = findSheetReferences([
    { pageIndex: 0, runs: [run('SEE A102 FOR ELEVATIONS'), run('3/M201', 100), run('A101'), run('A1020'), run('XA102'), run('S-501')] },
    { pageIndex: 1, runs: [run('REFER TO a.101')] },
  ], sheets);
  assert.deepEqual(links.map(link => [link.pageIndex, link.target, link.number]), [[0, 1, 'A-102'], [0, 2, 'M201'], [1, 0, 'A101']]);
});

test('sheet links are standard GoTo links that pdf.js resolves to the target page', async () => {
  const pdf = await PDFDocument.create(); for (let i = 0; i < 3; i++) pdf.addPage([300, 200]);
  const bytes = await applySheetLinks(await pdf.save(), [{ pageIndex: 0, rect: [10, 10, 60, 22], target: 2, number: 'M201' }]);
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const [link] = await (await doc.getPage(1)).getAnnotations();
  assert.equal(link.subtype, 'Link');
  assert.equal(await doc.getPageIndex(link.dest[0]), 2);
  await doc.cleanup();
  await assert.rejects(applySheetLinks(await pdf.save(), [{ pageIndex: 0, rect: [0, 0, 1, 1], target: 7, number: 'X' }]), /missing page/);
});
