import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { calibrateScale } from '../apps/opendraft/src/measurements.ts';
import { linkIntoWorkbook, quantityLinkSheets } from '../apps/opendraft/src/quantity-link.ts';

const scales = [calibrateScale({ id: 's', pageIndex: 0, points: [[0, 0], [100, 0]], distance: 10, unit: 'ft' })];
const slab = (id, x) => ({ id, pageIndex: 0, label: 'Slab', kind: 'area', points: [[x, 0], [x + 100, 0], [x + 100, 100], [x, 100]], unit: 'ft' });

test('takeoff sheets are added to an existing workbook without touching its own parts, then refreshed in place', async () => {
  const original = new Uint8Array(await readFile('tests/fixtures/estimate.xlsx'));
  const linked = linkIntoWorkbook(original, await quantityLinkSheets('plan.pdf', 1, { scales, records: [slab('a', 0)] }));
  const before = unzipSync(original), after = unzipSync(linked);
  for (const [path, data] of Object.entries(before)) if (!['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml'].includes(path)) assert.deepEqual(after[path], data, `${path} unchanged`);
  const book = strFromU8(after['xl/workbook.xml']);
  assert.match(book, /name="OpenDraft Summary"/); assert.match(book, /fullCalcOnLoad="1"/);
  assert.ok(book.indexOf('<calcPr') > book.indexOf('</definedNames>'), 'calcPr after definedNames (schema order)');
  // Refresh with two slabs: same sheet parts, updated totals, no duplicate sheets.
  const refreshed = linkIntoWorkbook(linked, await quantityLinkSheets('plan.pdf', 1, { scales, records: [slab('a', 0), slab('b', 200)] }));
  const again = strFromU8(unzipSync(refreshed)['xl/workbook.xml']);
  assert.equal(again.match(/name="OpenDraft Summary"/g).length, 1);
  assert.equal(Object.keys(unzipSync(refreshed)).length, Object.keys(after).length);
  assert.match(strFromU8(Object.entries(unzipSync(refreshed)).find(([p, d]) => p.startsWith('xl/worksheets/') && strFromU8(d).includes('Derived total'))[1]), /<v>200<\/v>/);
  assert.throws(() => linkIntoWorkbook(new Uint8Array([1, 2, 3]), []), /not an .xlsx/);
});
