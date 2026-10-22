import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFArray,PDFDict,PDFName,PDFNumber} from 'pdf-lib';
// @ts-ignore shared synthetic fixture
import {drawingFixture} from '../fixture.mjs';
const name=PDFName.of;
async function open(page:Page){
 await page.goto('/');await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'comments.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}
async function addMarkup(page:Page,kind='rectangle',contents='Check duct'){
 await page.getByLabel('Markup tool',{exact:true}).selectOption(kind);await page.getByLabel('Markup contents',{exact:true}).fill(contents);await page.getByLabel('Markup author',{exact:true}).fill('Designer');
 await page.getByRole('button',{name:'Add markup',exact:true}).click();await expect(page.locator('.markup-list button').filter({hasText:contents})).toBeVisible();
}
async function comment(page:Page,contents:string,reply=false){
 await page.getByLabel('Comment author',{exact:true}).fill('Reviewer');await page.getByLabel('Comment text',{exact:true}).fill(contents);
 await page.getByRole('button',{name:reply?'Reply to selected comment':'Add markup comment',exact:true}).click();
 await expect(page.getByText(reply?'Comment reply added.':'Comment added.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Comment thread',{exact:true}).getByText(contents,{exact:true})).toBeVisible();
 return page.getByLabel('Selected markup comment',{exact:true}).inputValue();
}
async function download(page:Page,label:string){const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:label,exact:true}).click()]);return readFile((await file.path())!);}
function annotations(pdf:PDFDocument){const arr=pdf.getPage(0).node.lookup(name('Annots'),PDFArray);return arr.asArray().map(ref=>({ref,dict:pdf.context.lookup(ref,PDFDict)}));}

test('comment replies edit, delete atomically, survive undo/recovery and export full thread evidence',async({page})=>{
 await open(page);await addMarkup(page);
 const root=await comment(page,'=SUM(1,2) Review dimension');
 const reply=await comment(page,'Confirmed against schedule',true);
 await page.getByLabel('Comment text',{exact:true}).fill('Confirmed against revised schedule');await page.getByRole('button',{name:'Update selected comment',exact:true}).click();
 await expect(page.getByLabel('Comment thread',{exact:true})).toContainText('Confirmed against revised schedule');
 let pdf=await PDFDocument.load(await download(page,'Save PDF')),a=annotations(pdf);
 expect(a).toHaveLength(3);expect(a[1].dict.get(name('IRT'))?.toString()).toBe(a[0].ref.toString());expect(a[2].dict.get(name('IRT'))?.toString()).toBe(a[1].ref.toString());
 for(const item of a.slice(1)){expect(item.dict.get(name('RT'))?.toString()).toBe('/R');expect(item.dict.lookup(name('F'),PDFNumber).asNumber()&32).toBe(32);expect(item.dict.lookup(name('F'),PDFNumber).asNumber()&4).toBe(0);}
 expect(a[2].dict.lookup(name('NM')).decodeText()).toContain(reply);
 const csv=(await download(page,'Export markup CSV')).toString('utf8');expect(csv).toContain('Comment count');expect(csv).toContain('Comments JSON');expect(csv).toContain('Confirmed against revised schedule');expect(csv).toContain(root);
 expect((await PDFDocument.load(await download(page,'Export markup PDF'))).getPageCount()).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();await expect(page.getByLabel('Comment thread',{exact:true}).getByText('Confirmed against schedule',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Redo edit',exact:true}).click();await expect(page.getByLabel('Comment thread',{exact:true})).toContainText('Confirmed against revised schedule');
 await page.getByLabel('Selected markup comment',{exact:true}).selectOption(root);await page.getByRole('button',{name:'Delete selected comment and replies',exact:true}).click();await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(0);
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(2);
 await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();await expect(page.getByText('Recovery saved locally',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'Restore retained session',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(1);
 await page.locator('.markup-list button').first().click();await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(2);
 await page.getByLabel('Markup contents',{exact:true}).fill('Updated rectangle');await page.getByRole('button',{name:'Update selected markup',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('Updated rectangle');await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(2);
 await page.getByLabel('Filter markups',{exact:true}).fill('revised schedule');await expect(page.locator('.markup-list button')).toHaveCount(1);
 pdf=await PDFDocument.load(await download(page,'Save PDF'));expect(annotations(pdf)).toHaveLength(3);
 pdf=await PDFDocument.load(await download(page,'Flatten OpenDraft markups'));expect(pdf.getPage(0).node.Annots()?.size()??0).toBe(0);
});

test('group member comments stay individual and both annotation and layer locks reject changes',async({page})=>{
 await open(page);await page.getByLabel('Layer name',{exact:true}).fill('Review layer');await page.getByRole('button',{name:'Create annotation layer',exact:true}).click();await expect(page.getByText('Annotation layer created.',{exact:true})).toBeVisible();
 await addMarkup(page,'rectangle','Group first');await addMarkup(page,'ellipse','Group second');
 await page.getByRole('button',{name:'Clear markup selection',exact:true}).click();await page.locator('.markup-list input').nth(0).check();await page.locator('.markup-list input').nth(1).check();await page.getByRole('button',{name:'Group selected markups',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('group');
 await page.locator('.markup-list button').nth(1).click();await comment(page,'Comment on second member');
 await page.locator('.markup-list button').first().click();await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(0);
 await page.locator('.markup-list button').nth(1).click();await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(1);
 await page.getByRole('button',{name:'Lock markup selection',exact:true}).click();await expect(page.locator('.markup-list button').nth(1)).toContainText('locked');
 await page.getByLabel('Comment text',{exact:true}).fill('Blocked annotation edit');await page.getByRole('button',{name:'Add markup comment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Unlock');await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(1);
 await page.getByRole('button',{name:'Unlock markup selection',exact:true}).click();await expect(page.locator('.markup-list button').nth(1)).not.toContainText('locked');
 await page.getByLabel('Layer edit locked',{exact:true}).check();await page.getByRole('button',{name:'Update annotation layer',exact:true}).click();await expect(page.getByText('Annotation layer updated.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add markup comment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('layer');await expect(page.getByLabel('Comment thread',{exact:true}).locator('article')).toHaveCount(1);
 const a=annotations(await PDFDocument.load(await download(page,'Save PDF')));expect(a).toHaveLength(3);
 const owner=a.find(item=>item.dict.lookup(name('Subtype')).toString()==='/Circle')!;
 const reply=a.find(item=>item.dict.get(name('RT'))?.toString()==='/R')!;
 expect(owner.dict.get(name('RT'))?.toString()).toBe('/Group');expect(reply.dict.get(name('IRT'))?.toString()).toBe(owner.ref.toString());
});
