import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
// @ts-ignore Node fixture shared with unit tests.
import { drawingFixture } from '../fixture.mjs';

test('local drawing renders, searches, zooms and exports a rotated PDF', async ({page}) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'drawing.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  const canvas=page.getByTestId('pdf-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('#page-label')).toHaveText('1 / 2');
  await expect.poll(()=>canvas.evaluate((el:HTMLCanvasElement)=>el.width)).toBeGreaterThan(0);
  await expect.poll(()=>canvas.evaluate((el:HTMLCanvasElement)=>{
    const pixels=el.getContext('2d')!.getImageData(0,0,el.width,el.height).data;
    let dark=0; for(let i=0;i<pixels.length;i+=4) if(pixels[i+3]>0 && pixels[i]<100 && pixels[i+1]<100 && pixels[i+2]<100) dark++;
    return dark;
  })).toBeGreaterThan(100);
  await expect(page.getByRole('button',{name:'Go to page 2',exact:true})).toBeVisible();
  const width=await canvas.evaluate((el:HTMLCanvasElement)=>el.width);
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await expect.poll(()=>canvas.evaluate((el:HTMLCanvasElement)=>el.width)).toBeGreaterThan(width);
  await page.getByLabel('Search document',{exact:true}).fill('Valve schedule');
  await page.getByRole('button',{name:'Find next',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await expect(page.getByText('Match on page 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Previous page',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('1 / 2');
  await page.getByRole('button',{name:'Rotate page clockwise',exact:true}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Save PDF',exact:true}).click()]);
  expect(download.suggestedFilename()).toBe('opendraft-drawing.pdf');
  const saved=await PDFDocument.load(await readFile((await download.path())!));
  expect(saved.getPages().map(p=>p.getRotation().angle)).toEqual([90,90]);
  await page.screenshot({path:'test-results/opendraft-viewer.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('multiple documents retain separate tabs and corrupt PDF shows an error', async ({page}) => {
  await page.goto('/');
  const buffer=Buffer.from(await drawingFixture());
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles([{name:'alpha.pdf',mimeType:'application/pdf',buffer},{name:'beta.pdf',mimeType:'application/pdf',buffer}]);
  await expect(page.getByRole('button',{name:'View alpha.pdf',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'View beta.pdf',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'View alpha.pdf',exact:true}).click();
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await page.getByRole('button',{name:'View beta.pdf',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('1 / 2');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'corrupt.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a PDF')});
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button',{name:'View beta.pdf',exact:true})).toBeVisible();
});
