import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
// @ts-ignore shared fixture
import {drawingFixture} from '../fixture.mjs';

test('opt-in recovery restores edited document after reload and deletes retained bytes',async({page})=>{
  page.on('dialog',dialog=>dialog.accept());
  await page.goto('/');
  await expect(page.getByLabel('Retain PDFs on this browser for recovery',{exact:true})).toBeEnabled();
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'recover.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(page.locator('#text')).toContainText('A101');
  await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();
  await page.getByRole('button',{name:'Delete page',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  await expect(page.locator('#text')).toContainText('B202');
  await expect(page.locator('#recovery-status')).toHaveText('Recovery saved locally');
  await page.reload();
  await page.getByRole('button',{name:'Restore retained session',exact:true}).click();
  await expect(page.getByRole('button',{name:'View recover.pdf',exact:true})).toBeVisible();
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  await expect(page.locator('#text')).toContainText('B202');
  await expect(page.getByRole('button',{name:'Undo edit',exact:true})).toBeDisabled();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Save PDF',exact:true}).click()]);
  const pdf=await PDFDocument.load(await readFile((await download.path())!));
  expect(pdf.getPageCount()).toBe(1);expect(pdf.getPage(0).getRotation().angle).toBe(90);
  await page.getByRole('button',{name:'Delete retained session',exact:true}).click();
  await expect(page.locator('#recovery-status')).toContainText('Retained PDFs deleted');
  await page.reload();
  await expect(page.locator('#recovery-status')).toContainText('Recovery off');
  await expect(page.getByRole('button',{name:'Restore retained session',exact:true})).toBeHidden();
});

test('default session does not retain opened PDF bytes',async({page})=>{
  await page.goto('/');
  await expect(page.getByLabel('Retain PDFs on this browser for recovery',{exact:true})).not.toBeChecked();
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'private.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(page.locator('#text')).toContainText('A101');
  await page.reload();
  await expect(page.locator('#recovery-status')).toContainText('Recovery off');
  await expect(page.getByRole('button',{name:'View private.pdf',exact:true})).toBeHidden();
});
