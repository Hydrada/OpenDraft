import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
// @ts-ignore shared synthetic fixture
import {drawingFixture} from '../fixture.mjs';

async function open(page:Page){
 await page.goto('/');await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'review.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
 await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}
async function add(page:Page,kind:string,contents:string,author:string,status:string){
 await page.getByLabel('Markup tool',{exact:true}).selectOption(kind);
 await page.getByLabel('Markup contents',{exact:true}).fill(contents);
 await page.getByLabel('Markup author',{exact:true}).fill(author);
 await page.getByLabel('Markup status',{exact:true}).selectOption(status);
 await page.getByRole('button',{name:'Add markup',exact:true}).click();
 await expect(page.locator('.markup-list button').filter({hasText:contents})).toBeVisible();
}
async function download(page:Page,label:string){
 const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:label,exact:true}).click()]);
 return readFile((await file.path())!);
}

test('review sorting and combined filters do not change PDF bytes, report scope or document order',async({page})=>{
 await open(page);
 await add(page,'rectangle','Duct review 10','Reviewer 10','accepted');
 await add(page,'ellipse','Duct review 2','Reviewer 2','open');
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('aria-label','PDF page 2');
 await add(page,'rectangle','Pipe review 1','Reviewer 1','rejected');
 const bytes=await download(page,'Save PDF'),rows=page.locator('.markup-list button');
 await page.getByLabel('Sort markup list by',{exact:true}).selectOption('author');
 await expect(rows.nth(0)).toContainText('Pipe review 1');await expect(rows.nth(1)).toContainText('Duct review 2');await expect(rows.nth(2)).toContainText('Duct review 10');
 await page.getByLabel('Markup sort direction',{exact:true}).selectOption('desc');await expect(rows.nth(0)).toContainText('Duct review 10');
 await page.getByLabel('Markup page filter',{exact:true}).selectOption('current');await expect(rows).toHaveCount(1);await expect(rows.first()).toContainText('Pipe review 1');
 await page.getByRole('button',{name:'Previous page',exact:true}).click();await expect(rows).toHaveCount(2);
 await page.getByLabel('Markup status filter',{exact:true}).selectOption('open');
 await page.getByLabel('Markup tool filter',{exact:true}).selectOption('ellipse');
 await page.getByLabel('Filter markups',{exact:true}).fill('REVIEWER 2');
 await expect(rows).toHaveCount(1);await expect(rows.first()).toContainText('Duct review 2');
 await expect(page.getByTestId('markup-list-summary')).toContainText('1 of 3');
 expect(await download(page,'Save PDF')).toEqual(bytes);
 const csv=(await download(page,'Export markup CSV')).toString('utf8');
 expect(csv).toContain('Duct review 10');expect(csv).toContain('Duct review 2');expect(csv).toContain('Pipe review 1');
 expect(csv.indexOf('Duct review 10')).toBeLessThan(csv.indexOf('Duct review 2'));
 await page.getByRole('button',{name:'Reset markup list controls',exact:true}).click();
 await expect(rows).toHaveCount(3);await expect(rows.first()).toContainText('Duct review 10');
 await expect(page.getByLabel('Sort markup list by',{exact:true})).toHaveValue('source');
});

test('filters show effective layer locks and explicitly retain selected group members outside results',async({page})=>{
 await open(page);
 await page.getByLabel('Layer name',{exact:true}).fill('Mechanical review');
 await page.getByRole('button',{name:'Create annotation layer',exact:true}).click();
 await expect(page.getByText('Annotation layer created.',{exact:true})).toBeVisible();
 const layerId=await page.getByLabel('Annotation layer',{exact:true}).inputValue();
 await add(page,'rectangle','Group box','Mechanical','open');await add(page,'ellipse','Group circle','Mechanical','open');
 await page.getByRole('button',{name:'Clear markup selection',exact:true}).click();
 await page.locator('.markup-list input').nth(0).check();await page.locator('.markup-list input').nth(1).check();
 await page.getByRole('button',{name:'Group selected markups',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('group');
 await page.getByLabel('Markup tool filter',{exact:true}).selectOption('rectangle');
 await expect(page.locator('.markup-list button')).toHaveCount(1);
 await expect(page.getByRole('region',{name:'Markup grouping'})).toContainText('1 selected outside the filtered list; actions include them');
 await page.getByLabel('Markup status',{exact:true}).selectOption('accepted');
 await page.getByRole('button',{name:'Apply selection properties',exact:true}).click();await expect(page.locator('.markup-list button').first()).toContainText('accepted');
 await page.getByLabel('Markup status filter',{exact:true}).selectOption('open');await expect(page.locator('.markup-list button')).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Markup grouping'})).toContainText('2 selected outside the filtered list; actions include them');
 await page.getByRole('button',{name:'Reset markup list controls',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(2);
 await expect(page.locator('.markup-list button').nth(1)).toContainText('accepted');
 await page.getByLabel('Layer edit locked',{exact:true}).check();await page.getByRole('button',{name:'Update annotation layer',exact:true}).click();
 await expect(page.getByText('Annotation layer updated.',{exact:true})).toBeVisible();
 await page.getByLabel('Markup lock filter',{exact:true}).selectOption('locked');
 await page.getByLabel('Markup layer filter',{exact:true}).selectOption(`layer:${layerId}`);
 await expect(page.locator('.markup-list button')).toHaveCount(2);await expect(page.locator('.markup-list button').first()).toContainText('locked');
 await page.getByLabel('Markup lock filter',{exact:true}).selectOption('unlocked');await expect(page.locator('.markup-list button')).toHaveCount(0);
 await page.getByRole('button',{name:'Unlock markup selection',exact:true}).click();await expect(page.getByRole('alert')).toContainText('layer');
 await page.getByRole('button',{name:'Clear markup selection',exact:true}).click();
 await expect(page.getByRole('region',{name:'Markup grouping'})).toContainText('0 markup(s) selected');
 await page.getByRole('button',{name:'Reset markup list controls',exact:true}).click();await expect(page.locator('.markup-list button')).toHaveCount(2);
});
