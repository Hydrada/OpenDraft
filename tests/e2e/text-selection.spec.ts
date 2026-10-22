import { test, expect } from '@playwright/test';
// @ts-ignore fixture is shared with the Node tests.
import { drawingFixture } from '../fixture.mjs';

test('PDF text is range-selectable and follows zoom and page rotation', async ({page}) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'selection.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  const text=page.getByTestId('pdf-text-layer').locator('span').filter({hasText:'OpenDraft synthetic drawing A101'});
  await expect(text).toHaveCount(1);
  const selection=await text.evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);
    const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
    const selected=selection.toString();const rect=range.getBoundingClientRect();
    const canvas=element.closest('.pdf-page-frame')!.querySelector('canvas')!.getBoundingClientRect();
    return {selected,x:rect.left-canvas.left,y:rect.top-canvas.top,width:rect.width,height:rect.height};
  });
  expect(selection.selected).toBe('OpenDraft synthetic drawing A101');
  expect(selection.x).toBeCloseTo(40,0);
  expect(selection.y).toBeGreaterThan(40);expect(selection.y).toBeLessThan(65);
  expect(selection.width).toBeGreaterThan(200);expect(selection.height).toBeGreaterThan(10);
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await expect.poll(async()=> (await text.boundingBox())?.width??0).toBeGreaterThan(selection.width*1.2);
  await page.getByRole('button',{name:'Rotate page clockwise',exact:true}).click();
  await expect.poll(async()=>{const b=await text.boundingBox();return b?b.height>b.width*5:false;}).toBe(true);
  expect(await text.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const s=window.getSelection()!;s.removeAllRanges();s.addRange(range);return s.toString();})).toBe('OpenDraft synthetic drawing A101');
});
