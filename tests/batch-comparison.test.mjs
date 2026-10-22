import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {batchCsvCell, validateBatchOptions, inspectBatchSource, runBatchComparison, BATCH_LIMITS} from '../apps/opendraft/src/batch-comparison.ts';
const options = {dpi: 72, threshold: 16, view: 'difference', reviewedAt: '2026-10-21T18:00:00.000Z'};
const pair = {id: 'one', basePage: 1, revisionPage: 1, reason: 'manual', scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0};
function source() {
  const bytes = new Uint8Array([1,2,3]);
  return {name: 'fixture.pdf', bytes, sha256: createHash('sha256').update(bytes).digest('hex'), pageCount: 1, labels: ['A101']};
}
test('CSV protects formulas after control characters, retains Unicode and escapes CSV syntax', () => {
  for (const value of ['=1+1', '+cmd', '-1', '@SUM(A1)', ' \t\u0000=HYPERLINK("x")']) assert.equal(batchCsvCell(value), '"\'' + value.replaceAll('"', '""') + '"');
  assert.equal(batchCsvCell('Å101, "水"\nline'), '"Å101, ""水""\nline"');
  assert.equal(batchCsvCell(null), '""');
  assert.equal(batchCsvCell(12), '"12"');
});
test('batch settings require supported resolution, bounded integral threshold, view and review timestamp', () => {
  const result = validateBatchOptions(options); assert.deepEqual(result, options); assert.notEqual(result, options);
  for (const patch of [{dpi: 73}, {dpi: '72'}, {threshold: -1}, {threshold: 256}, {threshold: 1.5}, {view: 'other'}, {reviewedAt: ''}, {reviewedAt: 'not-a-date'}]) assert.throws(() => validateBatchOptions({...options,...patch}));
});
test('pre-aborted jobs and inspection reject before parser or canvas access', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectBatchSource(source(), controller.signal), {name: 'AbortError'});
  await assert.rejects(runBatchComparison(source(), source(), [pair], options, controller.signal), {name: 'AbortError'});
});
test('modified reviewed bytes reject before parser work and keep both caller inputs unchanged', async () => {
  const base = source(), revision = source(); base.bytes[0] = 9;
  const before = base.bytes.slice(), otherBefore = revision.bytes.slice();
  await assert.rejects(runBatchComparison(base, revision, [pair], options), /snapshot changed after review/);
  assert.deepEqual(base.bytes, before); assert.deepEqual(revision.bytes, otherBefore);
});
test('invalid metadata and ambiguous pair assignment reject before parser work', async () => {
  await assert.rejects(runBatchComparison({...source(), labels: []}, source(), [pair], options), /metadata/);
  await assert.rejects(runBatchComparison(source(), source(), [pair,{...pair,id:'two'}], options), /once|duplicate|unique/i);
  await assert.rejects(runBatchComparison(source(), source(), [{...pair,basePage: 2}], options));
  await assert.rejects(runBatchComparison(source(), source(), [pair], {...options,dpi: 100}));
});
test('inspection rejects oversized sources without loading PDFjs', async () => {
  await assert.rejects(inspectBatchSource({name: 'large.pdf', bytes: new Uint8Array(BATCH_LIMITS.maxSourceBytes + 1)}), /64 MiB/);
  await assert.rejects(inspectBatchSource({name: 'empty.pdf', bytes: new Uint8Array()}), /64 MiB/);
});
