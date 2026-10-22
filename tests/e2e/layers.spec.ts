import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFDict,PDFName,PDFArray} from 'pdf-lib';
// @ts-ignore fixture
import {drawingFixture} from '../fixture.mjs';
async function open(page:import('@playwright/test').Page){
 await page.goto('/');await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'layers.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}
async function createLayer(page:import('@playwright/test').Page,name:string){
 await page.getByLabel('Annotation layer',{exact:true}).selectOption('');await page.getByLabel('Layer name',{exact:true}).fill(name);
 await page.getByRole('button',{name:'Create annotation layer',exact:true}).click();await expect(page.getByText('Annotation layer created.',{exact:true})).toBeVisible();
 return (await page.getByLabel('Annotation layer',{exact:true}).inputValue());
}
async function add(page:import('@playwright/test').Page,kind='rectangle',contents='Layered note'){
 await page.getByLabel('Markup tool',{exact:true}).selectOption(kind);await page.getByLabel('Markup contents',{exact:true}).fill(contents);await page.getByRole('button',{name:'Add markup',exact:true}).click();await expect(page.locator('.markup-list button').filter({hasText:contents})).toBeVisible();
}
async function exported(page:import('@playwright/test').Page,name='Save PDF'){
 const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name,exact:true}).click()]);return PDFDocument.load(await readFile((await file.path())!));
}
async function redPixels(page:import('@playwright/test').Page){return page.getByTestId('pdf-canvas').evaluate((canvas:HTMLCanvasElement)=>{const data=canvas.getContext('2d')!.getImageData(0,Math.floor(canvas.height*0.65),canvas.width,canvas.height-Math.floor(canvas.height*0.65)).data;let count=0;for(let n=0;n<data.length;n+=4)if(data[n]>150&&data[n+1]<100&&data[n+2]<100)count++;return count;});}

test('authored layer visibility changes pixels, exports real optional content and survives undo/recovery',async({page})=>{
 await open(page);const id=await createLayer(page,'Mechanical review');await add(page);
 await expect.poll(()=>redPixels(page)).toBeGreaterThan(100);
 await page.getByLabel('Layer visible',{exact:true}).uncheck();await page.getByRole('button',{name:'Update annotation layer',exact:true}).click();await expect.poll(()=>redPixels(page)).toBe(0);
 let pdf=await exported(page),oc=pdf.catalog.lookup(PDFName.of('OCProperties'),PDFDict),groups=oc.lookup(PDFName.of('OCGs'),PDFArray);
 expect(groups.size()).toBe(1);expect(oc.lookup(PDFName.of('D'),PDFDict).lookup(PDFName.of('OFF'),PDFArray).size()).toBe(1);
 expect(pdf.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray).lookup(0,PDFDict).get(PDFName.of('OC'))?.toString()).toBe(groups.get(0).toString());
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();await expect.poll(()=>redPixels(page)).toBeGreaterThan(100);await page.getByRole('button',{name:'Redo edit',exact:true}).click();await expect.poll(()=>redPixels(page)).toBe(0);
 await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();await expect(page.getByText('Recovery saved locally',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'Restore retained session',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(1);
 await page.getByLabel('Annotation layer',{exact:true}).selectOption(id);await expect(page.getByLabel('Layer visible',{exact:true})).not.toBeChecked();await expect.poll(()=>redPixels(page)).toBe(0);
 pdf=await exported(page,'Flatten OpenDraft markups');expect(pdf.getPage(0).node.Annots()?.size()??0).toBe(0);expect(pdf.catalog.has(PDFName.of('OCProperties'))).toBe(true);
 await page.getByLabel('Layer visible',{exact:true}).check();await page.getByRole('button',{name:'Update annotation layer',exact:true}).click();await expect.poll(()=>redPixels(page)).toBeGreaterThan(100);
});

test('layer edit locks protect individual/group changes and assignment without deleting annotations',async({page})=>{
 await open(page);const first=await createLayer(page,'Review team');await add(page,'rectangle','First member');await add(page,'cloud','Second member');
 await page.getByRole('button',{name:'Clear markup selection',exact:true}).click();await page.locator('.markup-list input').nth(0).check();await page.locator('.markup-list input').nth(1).check();await page.getByRole('button',{name:'Group selected markups',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('group');
 await page.getByLabel('Layer edit locked',{exact:true}).check();await page.getByRole('button',{name:'Update annotation layer',exact:true}).click();await expect(page.getByText('Annotation layer updated.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Delete markup selection',exact:true}).click();await expect(page.getByRole('alert')).toContainText('layer');await expect(page.locator('.markup-list button')).toHaveCount(2);
 await page.getByRole('button',{name:'Unlock markup selection',exact:true}).click();await expect(page.getByRole('alert')).toContainText('layer');
 await page.getByRole('button',{name:'Add markup',exact:true}).click();await expect(page.getByRole('alert')).toContainText('layer');await expect(page.locator('.markup-list button')).toHaveCount(2);
 const second=await createLayer(page,'Coordination');await page.getByRole('button',{name:'Assign selection to layer',exact:true}).click();await expect(page.getByRole('alert')).toContainText('layer');
 await page.getByLabel('Annotation layer',{exact:true}).selectOption(first);await page.getByLabel('Layer edit locked',{exact:true}).uncheck();await page.getByRole('button',{name:'Update annotation layer',exact:true}).click();await expect(page.getByLabel('Annotation layer',{exact:true})).toBeEnabled();
 await page.getByLabel('Annotation layer',{exact:true}).selectOption(second);await page.getByRole('button',{name:'Assign selection to layer',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('Coordination');await expect(page.locator('.markup-list button').nth(1)).toContainText('Coordination');
 await page.getByRole('button',{name:'Remove layer keeping markups',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(2);await expect(page.locator('.markup-list button').first()).not.toContainText('layer Coordination');
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('Coordination');
 const [report]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export markup CSV',exact:true}).click()]);const csv=await readFile((await report.path())!,'utf8');expect(csv).toContain('Layer name');expect(csv).toContain('Coordination');
});

test('invalid recovered layer references fail before replacing the retained workspace',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  // @ts-ignore real browser module
  const {saveRecovery,loadRecovery}=await import('/src/recovery.ts');
  const valid={version:1,documents:[],activeId:''};await saveRecovery(valid);
  const document={id:'x',name:'layers.pdf',bytes:new Uint8Array([37,80,68,70]),page:1,zoom:1,rotations:[],workspace:{sources:[{id:'s',bytes:new Uint8Array([37,80,68,70])}],pages:[{sourceId:'s',pageIndex:0,rotation:0}],layers:[],markups:[{id:'m',pageIndex:0,kind:'rectangle',layerId:'missing',points:[[1,1],[20,20]],color:[1,0,0],width:1,opacity:1,contents:'',author:'',status:'open',locked:false,createdAt:'2026-10-21T12:00:00.000Z',modifiedAt:'2026-10-21T12:00:00.000Z'}]}};
  let error='';try{await saveRecovery({version:1,documents:[document],activeId:'x'});}catch(value){error=String(value);}
  return {error,retained:await loadRecovery()};
 });
 expect(result.error).toMatch(/layer/i);expect(result.retained).toEqual({version:1,documents:[],activeId:''});
});
