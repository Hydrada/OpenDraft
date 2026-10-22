import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

test('reviewed sheet numbers become clickable links to their sheets in an exported copy', async ({ page }) => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheets: [string, string, string][] = [['A101', 'FIRST FLOOR PLAN', 'SEE A-102 FOR ELEVATIONS'], ['A102', 'ELEVATIONS', 'DETAIL 3/M201'], ['M201', 'MECHANICAL PLAN', 'REFER TO A101']];
  for (const [number, title, note] of sheets) {
    const p = pdf.addPage([800, 500]);
    p.drawText(note, { x: 60, y: 400, size: 14, font });
    p.drawText(number, { x: 600, y: 80, size: 24, font }); p.drawText(title, { x: 600, y: 55, size: 12, font });
  }
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'set.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 3');
  await page.getByRole('button', { name: 'Propose sheet index', exact: true }).click();
  await expect(page.getByLabel('Sheet number for page 3', { exact: true })).toHaveValue('M201');
  await page.getByRole('button', { name: 'Accept high-confidence suggestions', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF with links to reviewed sheets', exact: true }).click();
  const file = await (await download).path();
  await expect(page.getByRole('status', { name: 'Assistant status' })).toContainText('3 link(s) to 3 sheet(s)');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file!)) }).promise;
  const targets: number[][] = [];
  for (let n = 1; n <= 3; n++) {
    const links = (await (await doc.getPage(n)).getAnnotations()).filter((a: any) => a.subtype === 'Link');
    targets.push(await Promise.all(links.map(async (link: any) => (await doc.getPageIndex(link.dest[0])) + 1)));
  }
  expect(targets).toEqual([[2], [3], [1]]);
  await doc.cleanup();
});
