/** Authorized synthetic drawing/alignment fixtures. No user document content. */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';

const folder = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'opendraft-alignment-validation'));
await mkdir(folder, {recursive: true});
const hash = data => createHash('sha256').update(data).digest('hex');
if (process.argv.includes('--run')) {
  const {transformForComparison} = await import('../apps/opendraft/src/revision-transform.ts');
  const {estimateAlignment} = await import('../apps/opendraft/src/alignment-estimator.ts');
  const fixtures = JSON.parse(await readFile(path.join(folder, 'rasters.json'), 'utf8'));
  const load = async id => {
    const raster = fixtures.rasters[id];
    return {width: raster.width, height: raster.height, data: new Uint8ClampedArray(await readFile(path.join(folder, raster.file)))};
  };
  const transforms = [];
  for (const item of [...fixtures.transforms, ...fixtures.invalidTransforms]) {
    const base = await load(item.base), revision = await load(item.revision), before = [hash(base.data), hash(revision.data)];
    try {
      const result = transformForComparison(base, revision, item.matrix);
      await writeFile(path.join(folder, `${item.id}-base.rgba`), result.base.data);
      await writeFile(path.join(folder, `${item.id}-revision.rgba`), result.revision.data);
      transforms.push({id: item.id, geometry: result.geometry, base: {width: result.base.width, height: result.base.height, file: `${item.id}-base.rgba`}, revision: {width: result.revision.width, height: result.revision.height, file: `${item.id}-revision.rgba`}, inputHashesBefore: before, inputHashesAfter: [hash(base.data), hash(revision.data)]});
    } catch (error) {transforms.push({id: item.id, error: error.message, inputHashesBefore: before, inputHashesAfter: [hash(base.data), hash(revision.data)]});}
  }
  const estimates = [];
  for (const item of fixtures.estimates) {
    const base = await load(item.base), revision = await load(item.revision), before = [hash(base.data), hash(revision.data)];
    try {
      const result = await estimateAlignment(base, revision);
      estimates.push({id: item.id, result, inputHashesBefore: before, inputHashesAfter: [hash(base.data), hash(revision.data)]});
    } catch (error) {estimates.push({id: item.id, error: error.message, inputHashesBefore: before, inputHashesAfter: [hash(base.data), hash(revision.data)]});}
  }
  await writeFile(path.join(folder, 'engine-results.json'), JSON.stringify({transforms, estimates}, null, 2));
  console.log(`Ran ${transforms.length} warp/rejection and ${estimates.length} estimator cases in ${folder}`);
} else {
  const pdf = await PDFDocument.create({updateMetadata: false}), page = pdf.addPage([600, 500]);
  const font = await pdf.embedFont(StandardFonts.Helvetica), black = rgb(0, 0, 0);
  // Asymmetric, spatially distributed details make the known transform observable.
  let state = 1297729;
  const random = () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296;};
  for (let row = 0; row < 5; row++) for (let column = 0; column < 6; column++) {
    const id = row * 6 + column, x = 35 + column * 90 + random() * 10, y = 35 + row * 90 + random() * 12;
    const width = 25 + random() * 38, height = 18 + random() * 38;
    page.drawRectangle({x, y, width, height, borderWidth: 1 + id % 3, borderColor: black});
    page.drawLine({start: {x, y}, end: {x: x + width, y: y + height}, thickness: 1, color: black});
    if (id % 2) page.drawCircle({x: x + 13, y: y + height / 2, size: 4 + id % 5, borderWidth: 1.5, borderColor: black});
    page.drawText(`V${id + 11} ${Math.floor(random() * 900)}`, {x: x - 2, y: y + height + 4, size: 9 + id % 5, font, color: black});
    for (let bar = 0; bar < 3; bar++) page.drawRectangle({x: x + 4 + bar * 8, y: y + 3, width: 3, height: 3 + random() * 14, color: black});
  }
  const bytes = await pdf.save();
  await writeFile(path.join(folder, 'alignment-base.pdf'), bytes);
  await writeFile(path.join(folder, 'fixtures.json'), JSON.stringify({document: {file: 'alignment-base.pdf', sha256: hash(bytes)}, width: 600, height: 500}, null, 2));
  console.log(`Created authorized feature drawing in ${folder}`);
}
