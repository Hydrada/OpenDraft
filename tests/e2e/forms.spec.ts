import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore Shared Node fixture.
import { transmittalForm } from '../form-fixture.mjs';

test('form fields are listed, filled from the panel and saved as a filled copy', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'transmittal.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await transmittalForm()) });
  const status = page.getByRole('status', { name: 'Form status' });
  await expect(status).toHaveText('7 fillable field(s).');
  await expect(page.getByLabel('Form field form number', { exact: true })).toBeDisabled();
  await page.getByLabel('Form field project', { exact: true }).fill('North Pump Station');
  await page.getByLabel('Form field notes', { exact: true }).fill('Issued for review');
  await page.getByLabel('Form field sheet', { exact: true }).fill('M201');
  await page.getByLabel('Form field urgent', { exact: true }).check();
  await page.getByLabel('Form field status', { exact: true }).selectOption('Approved');
  await page.getByLabel('Form field discipline', { exact: true }).selectOption('Mechanical');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save filled form copy', exact: true }).click();
  const file = (await (await download).path())!;
  await expect(status).toContainText('Saved a filled copy');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file)) }).promise;
  const values = Object.fromEntries((await (await doc.getPage(1)).getAnnotations()).filter((a: any) => a.fieldName).map((a: any) => [a.fieldName, a.fieldValue]));
  expect(values.project).toBe('North Pump Station');
  expect(values.sheet).toBe('M201');
  expect(values.discipline).toEqual(['Mechanical']);
  expect(values.urgent).not.toBe('Off');
  await doc.cleanup();
});
