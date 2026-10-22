import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

function redPng(width: number, height: number) {
  const crc = (buffer: Buffer) => { let c = ~0; for (const byte of buffer) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0).map((_, i) => i % 3 === 0 ? 220 : 20)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('an uploaded PNG becomes an image stamp that renders on the sheet and saves as a standard Stamp', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'seal.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  await page.getByLabel('Markup tool', { exact: true }).selectOption('stamp');
  await page.getByLabel('Stamp image', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: redPng(30, 30) });
  for (const [label, value] of [['Markup x1', '100'], ['Markup y1', '100'], ['Markup x2', '300'], ['Markup y2', '300']]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Add markup', exact: true }).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  // Rendered artwork: the centre of the stamp is the image's red.
  await expect.poll(async () => page.getByTestId('pdf-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const c = canvas.getContext('2d')!; return Array.from(c.getImageData(Math.round(canvas.width * 200 / 600), Math.round(canvas.height * (400 - 200) / 400), 1, 1).data.slice(0, 3));
  })).toEqual([220, 20, 20]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save PDF' }).click();
  const saved = await PDFDocument.load(await readFile((await (await download).path())!));
  const [annot] = saved.getPage(0).node.Annots()!.asArray().map(ref => saved.context.lookup(ref) as any);
  expect(String(annot.lookup(PDFName.of('Subtype')))).toBe('/Stamp');
  expect(String(annot.lookup(PDFName.of('AP')).lookup(PDFName.of('N')).dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('XObject')).lookup(PDFName.of('Im0')).dict.lookup(PDFName.of('Subtype')))).toBe('/Image');
});
