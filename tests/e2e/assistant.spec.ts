import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore Node fixture shared with unit tests.
import { drawingFixture } from '../fixture.mjs';

test('assistant proposes a sheet index locally, exports only reviewed rows and never changes the document', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'set.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await drawingFixture()) });
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  const save = async () => { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Save PDF', exact: true }).click(); return readFile((await (await pending).path())!); };
  const before = await save();
  await expect(page.getByLabel('Suggestion engine', { exact: true })).toHaveValue('rules');
  await page.getByRole('button', { name: 'Propose sheet index', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Assistant status', exact: true })).toContainText('2 suggestion(s) for 2 page(s)');
  await expect(page.getByLabel('Sheet number for page 1', { exact: true })).toHaveValue('A101');
  await expect(page.getByLabel('Sheet number for page 2', { exact: true })).toHaveValue('B202');
  await expect(page.getByLabel('Accept sheet on page 1', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Export reviewed sheet index CSV', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Assistant status', exact: true })).toContainText('Accept at least one row');
  await page.getByLabel('Accept sheet on page 2', { exact: true }).check();
  await page.getByLabel('Sheet title for page 2', { exact: true }).fill('Valve schedule (reviewed)');
  const csvPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export reviewed sheet index CSV', exact: true }).click();
  expect(await readFile((await (await csvPending).path())!, 'utf8')).toBe('"Page","Sheet number","Sheet title"\r\n"2","B202","Valve schedule (reviewed)"\r\n');
  const pdfPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF with reviewed sheet bookmarks', exact: true }).click();
  const indexed = await readFile((await (await pdfPending).path())!);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(indexed) }).promise;
  const outline = await doc.getOutline();
  expect(outline.at(-1)!.title).toBe('Sheet index (reviewed)');
  expect(outline.at(-1)!.items.map(item => item.title)).toEqual(['B202 — Valve schedule (reviewed)']);
  expect(await doc.getPageIndex((outline.at(-1)!.items[0].dest as any[])[0])).toBe(1);
  await doc.cleanup();
  expect(Buffer.compare(await save(), before)).toBe(0);
});
