import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { calibrateScale } from '../apps/opendraft/src/measurements.ts';
import { applyTakeoffLegend, legendRows } from '../apps/opendraft/src/takeoff-legend.ts';

// 100 units = 10 ft on both pages.
const scales = [0, 1].map(pageIndex => calibrateScale({ id: `s${pageIndex}`, pageIndex, points: [[0, 0], [100, 0]], distance: 10, unit: 'ft' }));
const rec = (id, pageIndex, label, kind, points, extra = {}) => ({ id, pageIndex, label, kind, points, unit: 'ft', ...extra });
const takeoff = { scales, records: [
  rec('a', 0, 'Wall', 'length', [[0, 0], [100, 0]], { quantity: { multiplier: 2, wastePercent: 0, unitLabel: 'studs' } }),
  rec('b', 1, 'Wall', 'length', [[0, 0], [50, 0]], { quantity: { multiplier: 2, wastePercent: 0, unitLabel: 'studs' } }),
  rec('c', 0, 'Slab', 'area', [[0, 0], [100, 0], [100, 100], [0, 100]]),
  rec('d', 0, 'Valves', 'count', [[1, 1], [2, 2], [3, 3]]),
] };

test('legend rows group by label, type and unit and total values and derived quantities', () => {
  const rows = legendRows(takeoff, 2);
  assert.deepEqual(rows.map(r => [r.label, r.kind, r.count, Math.round(r.total * 1e6) / 1e6, r.unit, r.derived?.total, r.derived?.unit]), [
    ['Slab', 'area', 1, 100, 'ft²', undefined, undefined], ['Valves', 'count', 1, 3, 'count', undefined, undefined], ['Wall', 'length', 2, 15, 'ft', 30, 'studs'],
  ]);
  assert.deepEqual(legendRows(takeoff, 2, [1]).map(r => [r.label, r.total]), [['Wall', 5]]);
});

test('the legend is written as a movable FreeText annotation whose table text pdf.js renders', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([800, 600]); pdf.addPage([800, 600]);
  const out = await applyTakeoffLegend(await pdf.save(), legendRows(takeoff, 2), 0, [500, 580]);
  const doc = await PDFDocument.load(out), [annot] = doc.getPage(0).node.Annots().asArray().map(r => doc.context.lookup(r));
  assert.equal(String(annot.lookup(PDFName.of('Subtype'))), '/FreeText');
  assert.match(annot.lookup(PDFName.of('Contents')).decodeText(), /Wall \| length \| 2 \| 15 ft \| 30 studs/);
  const view = await pdfjs.getDocument({ data: out.slice() }).promise;
  const [rendered] = await (await view.getPage(1)).getAnnotations();
  assert.equal(rendered.subtype, 'FreeText'); assert.ok(rendered.hasAppearance);
  await view.cleanup();
  await assert.rejects(applyTakeoffLegend(await pdf.save(), legendRows(takeoff, 2), 0, [790, 580]), /does not fit/);
  await assert.rejects(applyTakeoffLegend(await pdf.save(), [], 0, [10, 500]), /no measurements/);
});

test('spaces name rooms: measurements are attributed to the space containing them, in reports and legends', async () => {
  const { takeoffCsv } = await import('../apps/opendraft/src/takeoff-reports.ts');
  const withSpaces = { scales, records: [
    rec('room1', 0, 'Office 101', 'space', [[0, 0], [200, 0], [200, 200], [0, 200]]),
    rec('room2', 0, 'Lobby', 'space', [[200, 0], [400, 0], [400, 200], [200, 200]]),
    rec('w1', 0, 'Wall', 'length', [[20, 20], [120, 20]]), rec('w2', 0, 'Wall', 'length', [[220, 20], [270, 20]]), rec('w3', 0, 'Wall', 'length', [[20, 300], [70, 300]]),
  ] };
  const rows = legendRows(withSpaces, 2);
  assert.deepEqual(rows.map(r => [r.space, r.label, r.kind, Math.round(r.total * 1e6) / 1e6]), [
    ['', 'Lobby', 'space', 400], ['', 'Office 101', 'space', 400], ['', 'Wall', 'length', 5], ['Lobby', 'Wall', 'length', 5], ['Office 101', 'Wall', 'length', 10],
  ]);
  const csv = takeoffCsv('plan.pdf', 2, withSpaces).trim().split('\r\n');
  assert.match(csv[0], /"Space"$/);
  assert.match(csv[3], /"Wall","length".*"Office 101"$/);
  assert.match(csv[5], /"Wall","length".*""$/);
});
