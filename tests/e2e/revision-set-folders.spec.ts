import {test, expect} from '@playwright/test';
import {PDFDocument} from 'pdf-lib';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {readFile} from 'node:fs/promises';
import {unzipSync, strFromU8} from 'fflate';

test('nested drawing folders ignore non-PDF files and isolate damaged PDFs without losing usable drawings', async ({page}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'opendraft-set-folders-'));
  for (const side of ['current', 'revision']) {
    const nested = path.join(root, side, 'nested'); await mkdir(nested, {recursive: true});
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 300]).drawText(`${side} authorized sheet`);
    await writeFile(path.join(nested, 'A.pdf'), await pdf.save());
    await writeFile(path.join(nested, 'readme.txt'), 'Synthetic non-PDF folder fixture');
  }
  await writeFile(path.join(root, 'current', 'broken.pdf'), '%PDF-1.7\nnot a valid PDF');
  await page.goto('/');
  await page.getByRole('button', {name: 'Revise drawing set', exact: true}).click();
  await page.getByLabel('Current drawing folder', {exact: true}).setInputFiles(path.join(root, 'current'));
  await page.getByLabel('Revision drawing folder', {exact: true}).setInputFiles(path.join(root, 'revision'));
  await page.getByLabel('Drawing set pairing strategy', {exact: true}).selectOption('order');
  await page.getByLabel('Drawing set reason', {exact: true}).fill('Authorized nested folder review');
  await page.getByRole('button', {name: 'Prepare drawing set', exact: true}).click();
  await expect(page.getByLabel('Drawing set review', {exact: true})).toBeVisible();
  const inspection = page.getByLabel('Drawing set inspection', {exact: true});
  await expect(inspection).toContainText('Ignored non-PDF files: current 1, revision 1.');
  await expect(inspection).toContainText(/broken\.pdf — inspection failed:/);
  await expect(inspection).toContainText(/A\.pdf — inspected 1 pages/);
  const mapping = page.getByLabel(/Revision file for current drawing \d+/, {exact: true});
  await expect(mapping).toHaveValue('revision-1');
  await page.getByLabel('Approve drawing set impact', {exact: true}).check();
  await page.getByRole('button', {name: 'Apply reviewed drawing set', exact: true}).click();
  await expect(page.getByLabel('Drawing set status', {exact: true})).toContainText('Drawing set finished: 1 succeeded, 0 failed.');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Download revised drawing set ZIP', exact: true}).click()]);
  expect(await download.failure()).toBeNull();
  const entries = unzipSync(await readFile((await download.path())!));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.results).toHaveLength(1);
  expect(manifest.results[0]).toMatchObject({status: 'succeeded', base: {name: 'A.pdf'}, revision: {name: 'A.pdf'}, outputPageCount: 1});
  const output = await PDFDocument.load(entries[manifest.results[0].outputPath]);
  expect(output.getPageCount()).toBe(1);
  expect(output.getPage(0).node.Contents()).toBeDefined();
});

test('cancelling delayed source inspection prevents stale review and allows fresh preparation', async ({page}) => {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 300]).drawText('Authorized delayed source');
  const bytes = Buffer.from(await pdf.save());
  await page.goto('/');
  await page.getByRole('button', {name: 'Revise drawing set', exact: true}).click();
  for (const side of ['Current', 'Revision']) await page.getByLabel(`${side} drawing files`, {exact: true}).setInputFiles({name: 'deferred.pdf', mimeType: 'application/pdf', buffer: bytes});
  await page.getByLabel('Drawing set pairing strategy', {exact: true}).selectOption('order');
  await page.getByLabel('Drawing set reason', {exact: true}).fill('Delayed inspection cancellation');
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    (window as any).inspectionEntered = false;
    File.prototype.arrayBuffer = function() {
      if (this.name !== 'deferred.pdf' || (window as any).inspectionEntered) return original.call(this);
      (window as any).inspectionEntered = true;
      return new Promise<ArrayBuffer>(resolve => {
        (window as any).releaseInspection = async () => resolve(await original.call(this));
      });
    };
  });
  await page.getByRole('button', {name: 'Prepare drawing set', exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).inspectionEntered)).toBe(true);
  await page.getByRole('button', {name: 'Cancel drawing set', exact: true}).click();
  await expect(page.getByLabel('Drawing set status', {exact: true})).toContainText(/cancel/i);
  await page.evaluate(async () => { await (window as any).releaseInspection(); });
  await expect(page.getByLabel('Drawing set review', {exact: true})).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Download revised drawing set ZIP', exact: true})).not.toBeVisible();
  await page.getByRole('button', {name: 'Prepare drawing set', exact: true}).click();
  await expect(page.getByLabel('Drawing set review', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Approve drawing set impact', {exact: true})).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Apply reviewed drawing set', exact: true})).toBeDisabled();
});
