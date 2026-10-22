import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFDict,PDFArray} from 'pdf-lib';
// @ts-ignore shared fixture
import {drawingFixture} from '../fixture.mjs';
async function open(page:import('@playwright/test').Page){
 await page.goto('/');
 await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'stamps.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
 await expect(page.getByTestId('pdf-canvas')).toBeVisible();
 await page.getByLabel('Markup tool',{exact:true}).selectOption('stamp');
}
async function exported(page:import('@playwright/test').Page,flatten=false){
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:flatten?'Flatten OpenDraft markups':'Save PDF',exact:true}).click()]);
 return PDFDocument.load(await readFile((await download.path())!));
}

test('standard stamp appearance persists in presets and exports as Stamp rather than a signature field',async({page})=>{
 await open(page);
 await page.getByLabel('Stamp appearance',{exact:true}).selectOption('Approved');
 await page.getByLabel('Markup contents',{exact:true}).fill('');
 await page.getByLabel('Preset name',{exact:true}).fill('Approval review stamp');
 await page.getByRole('button',{name:'Save new markup preset',exact:true}).click();
 await expect(page.getByText('1 preset(s) saved locally.',{exact:true})).toBeVisible();
 await page.getByLabel('Stamp appearance',{exact:true}).selectOption('Draft');
 await page.getByLabel('Markup tool',{exact:true}).selectOption('rectangle');
 await page.getByRole('button',{name:'Apply selected preset',exact:true}).click();
 await expect(page.getByLabel('Stamp appearance',{exact:true})).toHaveValue('Approved');
 await expect(page.getByLabel('Markup tool',{exact:true})).toHaveValue('stamp');
 await page.getByRole('button',{name:'Add markup',exact:true}).click();
 await expect(page.locator('.markup-list button')).toHaveCount(1);
 const pdf=await exported(page),annotation=pdf.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray).lookup(0,PDFDict);
 expect(annotation.get(PDFName.of('Subtype'))?.toString()).toBe('/Stamp');
 expect(annotation.get(PDFName.of('Name'))?.toString()).toBe('/Approved');
 expect(annotation.has(PDFName.of('AP'))).toBe(true);
 expect(pdf.catalog.has(PDFName.of('AcroForm'))).toBe(false);
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();
 await expect(page.locator('.markup-list button')).toHaveCount(0);
 await page.getByRole('button',{name:'Redo edit',exact:true}).click();
 await expect(page.locator('.markup-list button')).toHaveCount(1);
 const flat=await exported(page,true);
 expect(flat.getPage(0).node.Annots()?.size()??0).toBe(0);
});

test('drawn custom stamp survives recovery, editable properties, lock and report export',async({page})=>{
 await open(page);
 await page.getByLabel('Stamp appearance',{exact:true}).selectOption('ForComment');
 await page.getByLabel('Markup contents',{exact:true}).fill('CHECK CLEARANCE');
 const box=(await page.getByTestId('pdf-canvas').boundingBox())!;
 await page.mouse.move(box.x+40,box.y+100);await page.mouse.down();
 await page.mouse.move(box.x+220,box.y+180);await page.mouse.up();
 await expect(page.locator('.markup-list button')).toHaveCount(1);
 await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();
 await expect(page.getByText('Recovery saved locally',{exact:true})).toBeVisible();
 await page.reload();
 await page.getByRole('button',{name:'Restore retained session',exact:true}).click();
 await expect(page.locator('.markup-list button')).toHaveCount(1);
 await page.locator('.markup-list button').click();
 await expect(page.getByLabel('Stamp appearance',{exact:true})).toHaveValue('ForComment');
 await expect(page.getByLabel('Markup contents',{exact:true})).toHaveValue('CHECK CLEARANCE');
 await page.getByLabel('Markup locked',{exact:true}).check();
 await page.getByRole('button',{name:'Update selected markup',exact:true}).click();
 await expect(page.locator('.markup-list button')).toContainText('locked');
 await page.getByRole('button',{name:'Delete selected markup',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Unlock');
 const pdf=await exported(page),annotation=pdf.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray).lookup(0,PDFDict);
 expect(annotation.get(PDFName.of('Name'))?.toString()).toBe('/ForComment');
 expect(annotation.get(PDFName.of('Contents'))?.toString()).toBeTruthy();
 const reportButton=page.getByRole('button',{name:'Export markup CSV',exact:true});
 const [csv]=await Promise.all([page.waitForEvent('download'),reportButton.click()]);
 expect(await readFile((await csv.path())!,'utf8')).toContain('ForComment');
});
