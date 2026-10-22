import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
// @ts-ignore shared fixture
import { drawingFixture } from '../fixture.mjs';

test('organize, undo, insert and extract preserve expected page identities', async ({page}) => {
  await page.goto('/');
  const buffer=Buffer.from(await drawingFixture());
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'plan.pdf',mimeType:'application/pdf',buffer});
  await expect(page.locator('#text')).toContainText('A101');
  await page.getByRole('button',{name:'Move page later',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await expect(page.locator('#text')).toContainText('A101');
  await page.getByRole('button',{name:'Previous page',exact:true}).click();
  await expect(page.locator('#text')).toContainText('B202');
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();
  await expect(page.locator('#text')).toContainText('A101');
  await page.getByRole('button',{name:'Redo edit',exact:true}).click();
  await expect(page.locator('#text')).toContainText('B202');
  await page.getByRole('button',{name:'Delete page',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  await expect(page.getByRole('button',{name:'Delete page',exact:true})).toBeDisabled();
  await page.getByLabel('Insert PDF files',{exact:true}).setInputFiles({name:'insert.pdf',mimeType:'application/pdf',buffer});
  await expect(page.locator('#page-label')).toContainText('/ 3');
  const [extracted]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Extract page',exact:true}).click()]);
  const extract=await PDFDocument.load(await readFile((await extracted.path())!));
  expect(extract.getPageCount()).toBe(1);
  const [saved]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Save PDF',exact:true}).click()]);
  expect((await PDFDocument.load(await readFile((await saved.path())!))).getPageCount()).toBe(3);
});
