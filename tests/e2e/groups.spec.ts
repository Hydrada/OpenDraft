import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFDict,PDFArray} from 'pdf-lib';
// @ts-ignore fixture
import {drawingFixture} from '../fixture.mjs';
async function open(page:import('@playwright/test').Page){
 await page.goto('/');await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'groups.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
 await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}
async function add(page:import('@playwright/test').Page,kind:string,contents:string){
 await page.getByLabel('Markup tool',{exact:true}).selectOption(kind);await page.getByLabel('Markup contents',{exact:true}).fill(contents);
 await page.getByRole('button',{name:'Add markup',exact:true}).click();await expect(page.locator('.markup-list button').filter({hasText:contents})).toBeVisible();
}
async function groupFirstTwo(page:import('@playwright/test').Page){
 await page.getByRole('button',{name:'Clear markup selection',exact:true}).click();
 await page.locator('.markup-list input').nth(0).check();await page.locator('.markup-list input').nth(1).check();
 await page.getByRole('button',{name:'Group selected markups',exact:true}).click();
 await expect(page.locator('.markup-list button').nth(0)).toContainText('group');
}
async function downloadPdf(page:import('@playwright/test').Page,name='Save PDF'){
 const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name,exact:true}).click()]);return PDFDocument.load(await readFile((await file.path())!));
}
function annotations(pdf:PDFDocument,index=0){const list=pdf.getPage(index).node.lookup(PDFName.of('Annots'),PDFArray);return list.asArray().map(ref=>({ref,dict:pdf.context.lookup(ref,PDFDict)}));}
const numbers=(dict:PDFDict,key:string)=>dict.lookup(PDFName.of(key),PDFArray).asArray().map(value=>Number(value.toString()));

test('group actions export standard links and change members atomically with movement, locks and undo',async({page})=>{
 await open(page);await add(page,'rectangle','Group rectangle');await add(page,'callout','Group callout');await add(page,'ellipse','Independent ellipse');
 await groupFirstTwo(page);
 let pdf=await downloadPdf(page),a=annotations(pdf);
 expect(a[0].dict.has(PDFName.of('IRT'))).toBe(false);expect(a[1].dict.get(PDFName.of('IRT'))?.toString()).toBe(a[0].ref.toString());expect(a[1].dict.get(PDFName.of('RT'))?.toString()).toBe('/Group');expect(a[2].dict.has(PDFName.of('IRT'))).toBe(false);
 await page.getByLabel('Markup color',{exact:true}).fill('#00aa00');await page.getByLabel('Markup status',{exact:true}).selectOption('accepted');
 await page.getByRole('button',{name:'Apply selection properties',exact:true}).click();
 await expect(page.locator('.markup-list button')).toHaveCount(3);
 await page.getByLabel('Group move x',{exact:true}).fill('10');await page.getByLabel('Group move y',{exact:true}).fill('20');
 await page.getByRole('button',{name:'Move markup selection',exact:true}).click();
 pdf=await downloadPdf(page);a=annotations(pdf);
 expect(numbers(a[1].dict,'CL')).toEqual([30,100,40,160,50,160]);
 expect(numbers(a[0].dict,'C')[1]).toBeCloseTo(170/255,5);
 expect(numbers(a[2].dict,'C')[0]).toBeGreaterThan(0.8);
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();
 a=annotations(await downloadPdf(page));expect(numbers(a[1].dict,'CL')).toEqual([20,80,30,140,40,140]);
 await page.getByRole('button',{name:'Redo edit',exact:true}).click();
 await page.getByRole('button',{name:'Lock markup selection',exact:true}).click();
 await page.getByRole('button',{name:'Delete markup selection',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Unlock');await expect(page.locator('.markup-list button')).toHaveCount(3);
 await page.getByRole('button',{name:'Unlock markup selection',exact:true}).click();
 await page.getByLabel('Group move x',{exact:true}).fill('10000');await page.getByRole('button',{name:'Move markup selection',exact:true}).click();await expect(page.getByRole('alert')).toContainText('outside');
 a=annotations(await downloadPdf(page));expect(numbers(a[1].dict,'CL')).toEqual([30,100,40,160,50,160]);
 await page.locator('.markup-list button').nth(0).click();await expect(page.locator('.markup-list input:checked')).toHaveCount(2);
 await page.getByRole('button',{name:'Update selected markup',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Ungroup');
 await page.getByRole('button',{name:'Ungroup selected markups',exact:true}).click();a=annotations(await downloadPdf(page));expect(a.every(mark=>!mark.dict.has(PDFName.of('IRT')))).toBe(true);
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();
 await page.getByRole('button',{name:'Delete selected markup',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(1);await expect(page.locator('.markup-list button')).toContainText('Independent ellipse');
});

test('group membership follows page organization, extraction and retained recovery',async({page})=>{
 await open(page);await add(page,'rectangle','Page group A');await add(page,'cloud','Page group B');await groupFirstTwo(page);
 await page.getByRole('button',{name:'Move page later',exact:true}).click();
 await expect(page.locator('.markup-list button').first()).toContainText('Page 2');
 let pdf=await downloadPdf(page),a=annotations(pdf,1);expect(a[1].dict.get(PDFName.of('IRT'))?.toString()).toBe(a[0].ref.toString());
 pdf=await downloadPdf(page,'Extract page');a=annotations(pdf);expect(a[1].dict.get(PDFName.of('IRT'))?.toString()).toBe(a[0].ref.toString());
 await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();await expect(page.getByText('Recovery saved locally',{exact:true})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'Restore retained session',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(2);
 await page.locator('.markup-list button').first().click();await expect(page.locator('.markup-list input:checked')).toHaveCount(2);
 pdf=await downloadPdf(page);a=annotations(pdf,1);expect(a[1].dict.get(PDFName.of('IRT'))?.toString()).toBe(a[0].ref.toString());
 const [report]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export markup CSV',exact:true}).click()]);expect(await readFile((await report.path())!,'utf8')).toContain('Group ID');
 const flat=await downloadPdf(page,'Flatten OpenDraft markups');expect(flat.getPage(1).node.Annots()?.size()??0).toBe(0);
});

test('cross-page grouping is rejected without changing existing annotations',async({page})=>{
 await open(page);await add(page,'rectangle','First sheet');await page.getByRole('button',{name:'Next page',exact:true}).click();await add(page,'rectangle','Second sheet');
 await page.getByRole('button',{name:'Clear markup selection',exact:true}).click();await page.locator('.markup-list input').nth(0).check();await page.locator('.markup-list input').nth(1).check();
 await page.getByRole('button',{name:'Group selected markups',exact:true}).click();await expect(page.getByRole('alert')).toContainText('one page');
 const pdf=await downloadPdf(page);expect(annotations(pdf,0)[0].dict.has(PDFName.of('IRT'))).toBe(false);expect(annotations(pdf,1)[0].dict.has(PDFName.of('IRT'))).toBe(false);
});
