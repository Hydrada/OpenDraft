import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test('local print preparation rasterizes all pages with mixed sizes and waits for explicit print', async ({page}) => {
  const fixture=await PDFDocument.create(),font=await fixture.embedFont(StandardFonts.Helvetica);
  fixture.addPage([300,400]).drawText('Portrait sheet',{x:20,y:350,font});
  fixture.addPage([500,300]).drawText('Landscape sheet',{x:20,y:250,font});
  await page.goto('/');
  const moduleUrl='/@fs/'+path.resolve('node_modules/pdfjs-dist/build/pdf.mjs').replaceAll('\\','/');
  const workerUrl='/@fs/'+path.resolve('node_modules/pdfjs-dist/build/pdf.worker.min.mjs').replaceAll('\\','/');
  await page.evaluate(async ({bytes,moduleUrl,workerUrl})=>{
    const pdfjs=await import(/* @vite-ignore */ moduleUrl);
    pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
    const {preparePrint}=await import(/* @vite-ignore */ '/src/print.ts');
    const task=pdfjs.getDocument({data:new Uint8Array(bytes)}),pdf=await task.promise;
    const win=window as any;win.printCalls=0;window.print=()=>{win.printCalls++;};
    win.preparedPrint=await preparePrint(pdf,await pdf.getOptionalContentConfig({intent:'display'}));win.printTask=task;
  },{bytes:Array.from(await fixture.save()),moduleUrl,workerUrl});
  expect(await page.evaluate(()=>(window as any).printCalls)).toBe(0);
  // Pages are decoded PNG images at 200 dpi (canvases are released after encoding).
  const images=page.locator('#opendraft-print-root img');
  await expect(images).toHaveCount(2);
  expect(await page.evaluate(()=>(window as any).preparedPrint.dpi)).toBe(200);
  expect(await images.evaluateAll((items:HTMLImageElement[])=>items.map(i=>[i.naturalWidth,i.naturalHeight,i.style.width,i.style.height]))).toEqual([[834,1112,'300pt','400pt'],[1389,834,'500pt','300pt']]);
  expect(await images.first().evaluate((image:HTMLImageElement)=>{const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d')!;x.drawImage(image,0,0);const p=x.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]<80)n++;return n;})).toBeGreaterThan(50);
  await page.evaluate(()=>(window as any).preparedPrint.print());
  expect(await page.evaluate(()=>(window as any).printCalls)).toBe(1);
  const printed=await page.pdf({preferCSSPageSize:true,printBackground:true});
  const parsedTask=getDocument({data:new Uint8Array(printed)});
  try {
    const parsed=await parsedTask.promise;
    expect(parsed.numPages).toBe(2);
    // Chromium converts CSS page sizes through device units; allow <0.5pt rounding.
    for (const [number,expected] of [[1,[0,0,300,400]],[2,[0,0,500,300]]] as const) {
      const actual=(await parsed.getPage(number)).view;
      for(let index=0;index<4;index++) expect(Math.abs(actual[index]-expected[index])).toBeLessThan(0.5);
    }
  } finally {await parsedTask.destroy();}
  await page.evaluate(async()=>{(window as any).preparedPrint.dispose();await (window as any).printTask.destroy();});
  await expect(page.locator('#opendraft-print-root')).toHaveCount(0);
  await expect(page.locator('style[data-opendraft-print]')).toHaveCount(0);
});

test('print preparation rejects page and size limits before rendering',async({page})=>{
  await page.goto('/');
  const errors=await page.evaluate(async()=>{
    const {preparePrint}=await import(/* @vite-ignore */ '/src/print.ts');
    const results=[];
    for(const pdf of [{numPages:301},{numPages:300,getPage:async()=>({getViewport:()=>({width:2500,height:2500})})}]){
      try{await preparePrint(pdf);results.push('unexpected success');}catch(error){results.push(String(error));}
    }
    return results;
  });
  expect(errors[0]).toContain('1–300');expect(errors[1]).toContain('too large to print at 100 dpi');
  await expect(page.locator('#opendraft-print-root')).toHaveCount(0);
});
