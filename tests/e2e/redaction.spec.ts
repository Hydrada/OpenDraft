import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

test('search-and-redact removes matching text and everything else on that page, leaving other pages intact', async ({ page }) => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const one = pdf.addPage([600, 400]);
  one.drawText('OWNER ACCOUNT 4471-9921', { x: 60, y: 300, size: 20, font });
  one.drawText('Valve schedule', { x: 60, y: 100, size: 14, font });
  one.drawRectangle({ x: 300, y: 50, width: 200, height: 150, color: rgb(0.1, 0.4, 0.8) });
  pdf.addPage([600, 400]).drawText('PUBLIC SHEET A102', { x: 60, y: 300, size: 20, font });
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'owner.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 2');
  await page.getByLabel('Redact every occurrence of text', { exact: true }).fill('account');
  await page.getByRole('button', { name: 'Mark text matches for redaction', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Redaction status' })).toContainText('1 text match(es) marked');
  await expect(page.getByRole('list', { name: 'Redaction areas' }).locator('li')).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Apply redactions and save copy', exact: true }).click();
  const file = await (await download).path();
  await expect(page.getByRole('status', { name: 'Redaction status' })).toContainText('1 page(s) replaced');
  const redacted = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file!)) }).promise;
  expect(redacted.numPages).toBe(2);
  const text = async (n: number) => (await (await redacted.getPage(n)).getTextContent()).items.map((item: any) => item.str).join(' ');
  // Other text on the redacted page stays searchable; the redacted run is gone from text and bytes.
  expect(await text(1)).toBe('Valve schedule');
  expect(await text(1)).not.toContain('ACCOUNT');
  expect(await text(2)).toContain('PUBLIC SHEET A102');
  const raw = Buffer.from(await readFile(file!)).toString('latin1');
  expect(raw).not.toContain('4471');
  await redacted.cleanup();
  // Visual check in the app: open the redacted copy; the account line is solid black, the blue box remains.
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'redacted.pdf', mimeType: 'application/pdf', buffer: await readFile(file!) });
  await expect(page.locator('#document-name')).toHaveText('redacted.pdf');
  await expect(page.locator('#status')).toContainText('Page 1 of 2');
  const pixels = await page.getByTestId('pdf-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const c = canvas.getContext('2d')!, sx = canvas.width / 600, sy = canvas.height / 400;
    const at = (x: number, y: number) => Array.from(c.getImageData(Math.round(x * sx), Math.round((400 - y) * sy), 1, 1).data.slice(0, 3));
    return { redacted: at(150, 307), blue: at(400, 125), blank: at(550, 380) };
  });
  expect(Math.max(...pixels.redacted)).toBeLessThan(40);
  expect(pixels.blue[2]).toBeGreaterThan(150);
  expect(Math.min(...pixels.blank)).toBeGreaterThan(220);
});
