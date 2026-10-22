import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function calibrated(page: Page) {
  const pdf = await PDFDocument.create(); pdf.addPage([1000, 700]);
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'shapes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  // 100 PDF units = 10 ft.
  await page.getByLabel('Calibration reference points', { exact: true }).fill('0,0;100,0');
  await page.getByLabel('Known calibration distance', { exact: true }).fill('10');
  await page.getByLabel('Review calibration reference', { exact: true }).check();
  await page.getByRole('button', { name: 'Save reviewed calibration', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Measurement status', exact: true })).toContainText('Calibration saved');
}
async function add(page: Page, kind: string, label: string, points: string, cutouts = '') {
  await page.getByLabel('Measurement type', { exact: true }).selectOption(kind);
  await page.getByLabel('Measurement label', { exact: true }).fill(label);
  await page.getByLabel('Measurement points', { exact: true }).fill(points);
  await page.getByLabel('Area cutouts', { exact: true }).fill(cutouts);
  await page.getByRole('button', { name: 'Add measurement', exact: true }).click();
}
const status = (page: Page) => page.getByRole('status', { name: 'Measurement status', exact: true });

test('radius, diameter, arc and area with cutouts are measured from the panel and drawn on the sheet', async ({ page }) => {
  await calibrated(page);
  await add(page, 'radius', 'Tank radius', '500,350;530,390');
  await expect(status(page)).toContainText('Measurement added: 5.000000 ft');
  await add(page, 'diameter', 'Tank diameter', '500,350;550,350');
  await expect(status(page)).toContainText('Measurement added: 10.000000 ft');
  await add(page, 'arc', 'Curved wall', '550,350;500,400;450,350');
  await expect(status(page)).toContainText(`Measurement added: ${(Math.PI * 5).toFixed(6)} ft`);
  // 200x100 units = 20x10 ft = 200 ft²; openings 2x2 ft and 1x3 ft → 193 ft².
  await add(page, 'area', 'Slab', '0,0;200,0;200,100;0,100', '20,20;40,20;40,40;20,40 | 100,10;110,10;110,40;100,40');
  await expect(status(page)).toContainText('Measurement added: 193.000000 ft²');
  await expect(page.getByTestId('measurement-overlay').locator('title', { hasText: 'Slab cutout (deducted)' })).toHaveCount(2);
  // A cutout outside the outline is refused with a clear message and nothing is added.
  await add(page, 'area', 'Bad slab', '0,0;200,0;200,100;0,100', '190,90;250,90;250,95');
  await expect(page.locator('#error')).toContainText('inside the measured outline');
  await expect(page.locator('text=4 measurement(s) on this page.')).toBeVisible();
});

test('the takeoff legend export writes a table annotation that totals the page', async ({ page }) => {
  await calibrated(page);
  await add(page, 'area', 'Slab', '0,0;200,0;200,100;0,100', '20,20;40,20;40,40;20,40');
  await add(page, 'area', 'Slab', '300,0;400,0;400,100;300,100');
  await add(page, 'radius', 'Tank', '500,350;530,390');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF with takeoff legend', exact: true }).click();
  const { readFile } = await import('node:fs/promises');
  const { PDFDocument: Doc, PDFName: Name } = await import('pdf-lib');
  const saved = await Doc.load(await readFile((await (await download).path())!));
  const annots = saved.getPage(0).node.Annots()!.asArray().map(ref => saved.context.lookup(ref) as any);
  const legend = annots.find(a => String(a.lookup(Name.of('Subtype'))) === '/FreeText');
  const text = legend.lookup(Name.of('Contents')).decodeText();
  expect(text).toContain('Takeoff legend - page 1');
  expect(text).toContain('Slab | area | 2 | 296 ft²'); // 196 + 100
  expect(text).toContain('Tank | radius | 1 | 5 ft');
  await expect(page.locator('#status')).toContainText('2-row takeoff legend on page 1');
});

test('dynamic fill traces a clicked room from the rendered drawing and measures it', async ({ page }) => {
  const { PDFDocument: Doc, rgb } = await import('pdf-lib');
  const pdf = await Doc.create(), sheet = pdf.addPage([1000, 700]);
  sheet.drawRectangle({ x: 100, y: 100, width: 300, height: 200, borderWidth: 3, borderColor: rgb(0, 0, 0) });
  sheet.drawText('OFFICE', { x: 200, y: 200, size: 14 });
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'room.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  await page.getByLabel('Calibration reference points', { exact: true }).fill('0,0;100,0');
  await page.getByLabel('Known calibration distance', { exact: true }).fill('10');
  await page.getByLabel('Review calibration reference', { exact: true }).check();
  await page.getByRole('button', { name: 'Save reviewed calibration', exact: true }).click();
  await page.getByRole('button', { name: 'Fill area at a point', exact: true }).click();
  // Click PDF point (300,150): scroll the canvas into view first; the page is taller than the test viewport.
  const canvas = page.getByTestId('pdf-canvas'), bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: bounds.width * 300 / 1000, y: bounds.height * (700 - 150) / 700 }, force: true });
  const status = page.getByRole('status', { name: 'Measurement status', exact: true });
  await expect(status).toContainText('Filled region traced with');
  await expect(page.getByLabel('Measurement type', { exact: true })).toHaveValue('area');
  await page.getByLabel('Measurement label', { exact: true }).fill('Office floor');
  await page.getByRole('button', { name: 'Add measurement', exact: true }).click();
  await expect(status).toContainText('Measurement added');
  const value = Number((await status.textContent())!.match(/Measurement added: ([\d.]+)/)![1]);
  // Inner faces of 3 pt walls: 297 x 197 units = 585.09 ft²; raster tracing within 2 %.
  expect(Math.abs(value - 585.09) / 585.09).toBeLessThan(0.02);
});

test('the quantity link refreshes OpenDraft sheets inside an existing workbook', async ({ page }) => {
  await calibrated(page);
  await add(page, 'area', 'Slab', '0,0;200,0;200,100;0,100');
  const download = page.waitForEvent('download');
  await page.getByLabel('Excel workbook to link', { exact: true }).setInputFiles('tests/fixtures/estimate.xlsx');
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('estimate.xlsx');
  const { readFile } = await import('node:fs/promises');
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(await readFile((await saved.path())!)));
  expect(strFromU8(files['xl/workbook.xml'])).toContain('name="Estimate"');
  const summary = Object.values(files).map(strFromU8).find(text => text.includes('Derived total'))!;
  expect(summary).toContain('<v>200</v>');
});

test('sketch to scale draws a line of an exact real length from a start point', async ({ page }) => {
  await calibrated(page);
  await page.getByLabel('Measurement points', { exact: true }).fill('100,100');
  await page.getByLabel('Sketch length (in the measurement unit)', { exact: true }).fill('12');
  await page.getByLabel('Sketch angle (degrees, 0 = right, 90 = up)', { exact: true }).fill('30');
  await page.getByRole('button', { name: 'Sketch to scale from the first point', exact: true }).click();
  await expect(page.getByLabel('Measurement type', { exact: true })).toHaveValue('length');
  await page.getByLabel('Measurement label', { exact: true }).fill('Pipe run');
  await page.getByRole('button', { name: 'Add measurement', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Measurement status', exact: true })).toContainText('Measurement added: 12.000000 ft');
});
