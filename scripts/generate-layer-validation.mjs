/** Independent layer fixtures. Pass a TEMP directory during concurrent browser tests. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { applyMarkups } from '../apps/opendraft/src/annotations.ts';

const output = path.resolve(process.argv[2] ?? 'test-results/layer-validation');
await mkdir(output, { recursive: true });
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
const time = '2026-10-21T12:00:00.000Z', marks = [];
for (let index = 0; index < 2; index++) {
  const page = pdf.addPage([400, 400]);
  if (index) page.setRotation(degrees(90));
  page.drawText('Synthetic layer visibility reference', { x: 20, y: 360, font, size: 14 });
  page.drawLine({ start: { x: 20, y: 250 }, end: { x: 370, y: 250 }, thickness: 1 });
  marks.push({ id: `layer-rectangle-${index}`, pageIndex: index, kind: 'rectangle', layerId: 'review', points: [[60, 100], [280, 200]], color: [0.8, 0.1, 0.2], width: 3, opacity: 0.7, contents: 'Review layer visibility; nonempty annotation contents.', author: 'Synthetic tester', status: 'open', locked: false, createdAt: time, modifiedAt: time });
}
const bytes = await pdf.save();
await writeFile(path.join(output, 'baseline.pdf'), bytes);
const cases = [];
for (const visible of [true, false]) for (const flatten of [false, true]) {
  const name = `${visible ? 'visible' : 'hidden'}-${flatten ? 'flattened' : 'annotated'}.pdf`;
  await writeFile(path.join(output, name), await applyMarkups(bytes, marks, { flatten, layers: [{ id: 'review', name: 'Review comments', visible, locked: false }] }));
  cases.push({ name, visible, flatten, expectedAnnotationCount: flatten ? 0 : 1 });
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ fixture: 'synthetic-layer-rectangles-rotation0-90', pageCount: 2, renderScale: 1.5, tolerance: { meanChannelDifference: 0.25, changedChannelFraction: 0.01 }, cases }, null, 2) + '\n');
console.log(`Wrote layer fixtures under ${output}`);
