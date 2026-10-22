import {test, expect, type Page} from '@playwright/test';
import {PDFDocument, PDFName, PDFString, rgb} from 'pdf-lib';
import {unzipSync, strFromU8} from 'fflate';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

async function drawing(labels: string[], kinds: number[]) {
  const pdf = await PDFDocument.create({updateMetadata: false});
  kinds.forEach(kind => {
    const page = pdf.addPage(kind === 9 ? [3000, 3000] : [200, 160]);
    page.drawRectangle({x: 20, y: 100, width: 40, height: 20, color: rgb(0, 0, 0)});
    if (kind === 1) page.drawRectangle({x: 80, y: 100, width: 20, height: 20, color: rgb(0, 0, 0)});
    if (kind === 2) page.drawRectangle({x: 120, y: 40, width: 20, height: 20, color: rgb(0, 0, 0)});
  });
  pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({Nums: labels.flatMap((label, i) => [i, {P: PDFString.of(label)}])}));
  return Buffer.from(await pdf.save());
}
async function open(page: Page, base: Buffer, revision: Buffer) {
  await page.goto('/');
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles([{name: 'base.pdf', mimeType: 'application/pdf', buffer: base}, {name: 'revision.pdf', mimeType: 'application/pdf', buffer: revision}]);
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(2);
  await expect(page.locator('#page canvas')).toBeVisible();
  await page.getByRole('button', {name: 'Batch revision review', exact: true}).click();
  await page.getByLabel('Batch base document', {exact: true}).selectOption({label: 'base.pdf'});
  await page.getByLabel('Batch revision document', {exact: true}).selectOption({label: 'revision.pdf'});
}
async function prepare(page: Page) {
  await page.getByRole('button', {name: 'Prepare sheet pairs', exact: true}).click();
  await expect(page.getByLabel('Sheet pairing review', {exact: true})).toBeVisible();
}
async function run(page: Page) {
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).check();
  await page.getByRole('button', {name: 'Compare reviewed batch', exact: true}).click();
  await expect(page.getByLabel('Batch status', {exact: true})).toContainText('Batch ready');
}
async function download(page: Page, button: string) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: button, exact: true}).click()]);
  return readFile((await file.path())!);
}
test('label pairing exports reordered sheets, known differences, partial failures and unchanged sources', async ({page}) => {
  const base = await drawing(['A101', 'B202', 'C303', 'D404'], [1, 0, 9, 0]);
  const revision = await drawing(['b202', ' a101 ', 'C303', 'E505'], [0, 2, 9, 0]);
  await open(page, base, revision); await prepare(page);
  await expect(page.getByLabel('Revision for base page 1', {exact: true})).toHaveValue('2');
  await expect(page.getByLabel('Revision for base page 2', {exact: true})).toHaveValue('1');
  await expect(page.getByLabel('Revision for base page 4', {exact: true})).toHaveValue('0');
  await run(page); await expect(page.getByLabel('Batch status', {exact: true})).toContainText('2 compared, 1 failed');
  const zip = await download(page, 'Export batch ZIP'), files = unzipSync(zip);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.base.sha256).toBe(createHash('sha256').update(base).digest('hex'));
  expect(manifest.revision.sha256).toBe(createHash('sha256').update(revision).digest('hex'));
  expect(manifest.results[0]).toMatchObject({basePage: 1, revisionPage: 2, status: 'compared', changedPixels: 800});
  expect(manifest.results[1]).toMatchObject({basePage: 2, revisionPage: 1, status: 'compared', changedPixels: 0});
  expect(manifest.results[2]).toMatchObject({basePage: 3, revisionPage: 3, status: 'failed'});
  const dir = path.join(tmpdir(), 'opendraft-batch-validation'); await mkdir(dir, {recursive: true});
  const expected = {pairs: [{basePage: 1, revisionPage: 2, status: 'compared', changedPixels: 800}, {basePage: 2, revisionPage: 1, status: 'compared', changedPixels: 0, changedBounds: null}, {basePage: 3, revisionPage: 3, status: 'failed'}], unmatchedBase: [4], unmatchedRevision: [4]};
  await Promise.all([writeFile(path.join(dir, 'batch.zip'), zip), writeFile(path.join(dir, 'base.pdf'), base), writeFile(path.join(dir, 'revision.pdf'), revision), writeFile(path.join(dir, 'expected.json'), JSON.stringify(expected))]);
  await page.getByRole('button', {name: 'Close batch review', exact: true}).click();
  expect(await download(page, 'Save PDF')).toEqual(revision);
  await page.getByRole('button', {name: 'View base.pdf', exact: true}).click();
  expect(await download(page, 'Save PDF')).toEqual(base);
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
});
test('direct batch engine validates reviewed snapshots, manual similarity extents, formula-safe CSV and all-failed output', async ({page}) => {
  const small = await drawing(['=SUM(1,2)'], [0]), large = await drawing(['A'], [9]);
  await page.goto('/');
  await expect(page.getByLabel('Open PDF files', {exact: true})).toBeEnabled();
  const output = await page.evaluate(async ({small, large}) => {
    // @ts-ignore Browser imports the actual application engine through Vite.
    const engine = await import('/src/batch-comparison.ts');
    const source = await engine.inspectBatchSource({name: '=drawing.pdf', bytes: new Uint8Array(small)});
    const pair = {id: 'manual-1', basePage: 1, revisionPage: 1, reason: 'manual', scale: 1, rotationDegrees: 90, offsetX: 160, offsetY: 0};
    const options = {dpi: 72, threshold: 16, view: 'difference', reviewedAt: new Date().toISOString()};
    const result = await engine.runBatchComparison(source, source, [pair], options);
    const manifest = result.manifest;
    const huge = await engine.inspectBatchSource({name: 'huge.pdf', bytes: new Uint8Array(large)});
    const failed = await engine.runBatchComparison(huge, huge, [{...pair, rotationDegrees: 0, offsetX: 0}], options);

    const forged = {...source, bytes: source.bytes.slice()}; forged.bytes[0] ^= 1;
    let rejected = '';
    try { await engine.runBatchComparison(forged, source, [pair], options); } catch (e) { rejected = String(e); }
    return {manifest, zip: [...result.zip], failedManifest: failed.manifest, failedZip: [...failed.zip], rejected};
  }, {small: [...small], large: [...large]});
  expect(output.manifest.results[0]).toMatchObject({status: 'compared', geometry: {width: 200, height: 200, originX: 0, originY: 0}, alignment: {matrix: [0, 1, -1, 0, 160, 0]}});
  expect(strFromU8(unzipSync(new Uint8Array(output.zip))['summary.csv'])).toContain("\"'=SUM(1,2)\"");
  expect(output.failedManifest.results[0].status).toBe('failed');
  expect(output.failedManifest.pdfPath).toBeNull();
  expect(Object.keys(unzipSync(new Uint8Array(output.failedZip))).sort()).toEqual(['manifest.json', 'summary.csv']);
  expect(output.rejected).toContain('snapshot changed');
});
test('ambiguous labels require manual mapping, duplicate use rejects, changes revoke approval and cancellation discards exports', async ({page}) => {
  await open(page, await drawing(['A', 'a'], [0, 1]), await drawing(['A', 'B'], [0, 2])); await prepare(page);
  await expect(page.getByLabel('Revision for base page 1', {exact: true})).toHaveValue('0');
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).click();
  await expect(page.getByLabel('Batch error', {exact: true})).toContainText('Select between');
  await page.getByLabel('Revision for base page 1', {exact: true}).selectOption('1');
  await page.getByLabel('Revision for base page 2', {exact: true}).selectOption('1');
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).click();
  await expect(page.getByLabel('Batch error', {exact: true})).toContainText('at most once');
  await page.getByLabel('Revision for base page 2', {exact: true}).selectOption('2');
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).check();
  await page.getByLabel('X offset for base page 1', {exact: true}).fill('10');
  await expect(page.getByLabel('Approve batch sheet pairs', {exact: true})).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Compare reviewed batch', exact: true})).toBeDisabled();
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).check();
  await page.evaluate(() => {
    const dialog = document.querySelector('.batch-dialog')!;
    (dialog.querySelector('[data-action="run"]') as HTMLButtonElement).click();
    (dialog.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
  });
  await expect(page.getByLabel('Batch status', {exact: true})).toContainText('cancelled');
  await expect(page.getByLabel('Batch results', {exact: true})).toBeHidden();
  await page.getByLabel('Batch threshold', {exact: true}).fill('256');
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).check();
  await page.getByRole('button', {name: 'Compare reviewed batch', exact: true}).click();
  await expect(page.getByLabel('Batch error', {exact: true})).toContainText('threshold');
});
