import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
// @ts-ignore Shared Node fixture.
import { foreignPdf } from '../foreign-fixture.mjs';

test('other tools\' annotations import into a new editable tab and save without duplicates', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'reviewed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await foreignPdf()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  await page.getByRole('button', { name: 'Import existing annotations for editing', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Imported 9 annotation(s) as editable markups in a new tab');
  await expect(page.locator('#document-name')).toHaveText('reviewed (editable markups).pdf');
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(2);
  await expect(page.locator('.markup-list button')).toHaveCount(9);
  // Regression (found with Cua): imported markups must render and save before any edit.
  const edge = await page.getByTestId('pdf-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const c = canvas.getContext('2d')!, sx = canvas.width / 800, sy = canvas.height / 600;
    // Left edge of the imported blue Square at x=100, y=150 (PDF units).
    let blue = 0; for (let dx = -3; dx <= 3; dx++) { const [r, g, b] = c.getImageData(Math.round((100 + dx) * sx), Math.round((600 - 150) * sy), 1, 1).data; if (b > 150 && r < 100) blue++; }
    return blue;
  });
  expect(edge).toBeGreaterThan(0);
  const early = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save PDF' }).click();
  const earlyDoc = await PDFDocument.load(await (await import('node:fs/promises')).readFile((await (await early).path())!));
  const earlyNames = earlyDoc.getPage(0).node.Annots()!.asArray().map(ref => (earlyDoc.context.lookup(ref) as any).lookup(PDFName.of('NM'))?.decodeText?.() ?? '');
  expect(earlyNames.filter(name => name.startsWith('opendraft:import-'))).toHaveLength(9);
  // The imported rectangle is a normal editable markup: select it, change its note, update.
  await page.locator('.markup-list button', { hasText: 'Check clearance' }).first().click();
  await page.getByLabel('Markup contents', { exact: true }).fill('Clearance confirmed');
  await page.getByRole('button', { name: 'Update selected markup', exact: true }).click();
  await expect(page.locator('.markup-list button', { hasText: 'Clearance confirmed' })).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save PDF' }).click();
  const saved = await PDFDocument.load(await (await download).createReadStream().then(async stream => { const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk as Buffer); return Buffer.concat(chunks); }));
  const annots = saved.getPage(0).node.Annots()!.asArray().map(ref => saved.context.lookup(ref) as any);
  const contents = annots.map(a => a.lookup(PDFName.of('Contents'))?.decodeText?.() ?? '');
  expect(contents.filter(text => text === 'Clearance confirmed')).toHaveLength(1);
  expect(contents.filter(text => text === 'Check clearance')).toHaveLength(0);
  // Measurement and link annotations the importer left alone are still present exactly once.
  const subtypes = annots.map(a => String(a.lookup(PDFName.of('Subtype'))));
  expect(subtypes.filter(s => s === '/Link')).toHaveLength(1);
});
