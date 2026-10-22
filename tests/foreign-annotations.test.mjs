import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { importForeignAnnotations } from '../apps/opendraft/src/foreign-annotations.ts';
import { applyMarkups } from '../apps/opendraft/src/annotations.ts';

import { foreignPdf } from './foreign-fixture.mjs';

test('standard foreign markups become editable OpenDraft markups and are removed from the copy', async () => {
  const result = await importForeignAnnotations(await foreignPdf(), '2026-10-21T00:00:00.000Z');
  const by = kind => result.markups.filter(mark => mark.kind === kind);
  assert.deepEqual(result.markups.map(mark => mark.kind).sort(), ['arrow', 'callout', 'cloud', 'ink', 'ink', 'rectangle', 'stamp', 'stamp', 'text'].sort());
  const [rect] = by('rectangle');
  assert.deepEqual(rect.points, [[100, 100], [300, 200]]);
  assert.deepEqual(rect.color, [0, 0, 1]); assert.equal(rect.width, 3); assert.equal(rect.opacity, 0.8);
  assert.equal(rect.author, 'Reviewer A'); assert.equal(rect.contents, 'Check clearance');
  assert.equal(rect.createdAt, '2026-01-15T09:30:00.000Z'); assert.equal(rect.modifiedAt, '2026-01-16T10:00:00.000Z');
  assert.deepEqual(rect.comments?.map(c => [c.author, c.contents]), [['Designer', 'Done, see rev B']]);
  assert.deepEqual(by('arrow')[0].points, [[50, 400], [250, 500]]);
  const callout = by('callout')[0];
  assert.deepEqual(callout.points, [[500, 100], [700, 160]]);
  assert.deepEqual(callout.callout.at(-1), [500, 120]);
  assert.deepEqual(by('stamp').map(mark => [mark.stampName, mark.contents]).sort(), [['Approved', ''], ['Draft', 'Reviewed by MEP']]);
  assert.equal(by('text')[0].contents, 'Sticky note');
  // Measurement, link and non-WinAnsi annotations are left in the PDF and reported.
  assert.ok(result.skipped.some(item => /Measurement/.test(item.reason)));
  assert.ok(result.skipped.some(item => /WinAnsi/.test(item.reason)));
  const clean = await PDFDocument.load(result.bytes);
  const left = clean.getPage(0).node.Annots().asArray().map(ref => clean.context.lookup(ref).lookup(PDFName.of('Subtype')).toString());
  assert.deepEqual(left.sort(), ['/Line', '/Link', '/Square'].sort());
  // Round trip: writing the imported markups back produces exactly one copy of each.
  const saved = await applyMarkups(result.bytes, result.markups);
  const doc = await pdfjs.getDocument({ data: saved.slice() }).promise;
  const annotations = await (await doc.getPage(1)).getAnnotations();
  assert.equal(annotations.filter(a => a.subtype === 'Square' && a.contentsObj?.str === 'Check clearance').length, 1);
  await doc.cleanup();
  const written = await PDFDocument.load(saved);
  const names = written.getPage(0).node.Annots().asArray().map(ref => written.context.lookup(ref).lookup(PDFName.of('NM'))?.decodeText?.() ?? '');
  assert.equal(names.filter(name => name.startsWith('opendraft:import-')).length, result.markups.length);
  assert.equal(names.filter(name => name.startsWith('opendraft:reply-') || name.startsWith('opendraft:comment:reply-')).length, 1);
});

test('documents without foreign markups import nothing and keep their annotations', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]);
  const result = await importForeignAnnotations(await pdf.save());
  assert.deepEqual(result.markups, []); assert.deepEqual(result.skipped, []);
});
