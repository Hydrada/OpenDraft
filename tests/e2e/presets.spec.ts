import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
// @ts-ignore shared synthetic fixture
import {drawingFixture} from '../fixture.mjs';
const key='opendraft.markup-presets.v1';
async function openDrawing(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'presets.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await page.getByLabel('Markup tool',{exact:true}).selectOption('cloud');
  await page.getByLabel('Markup contents',{exact:true}).fill('Review pipe spacing');
  await page.getByLabel('Preset name',{exact:true}).fill('Pipe review');
}

test('presets persist, round-trip JSON and apply style without editing existing annotations or identity fields',async({page})=>{
  await openDrawing(page);
  await page.getByLabel('Markup author',{exact:true}).fill('Engineer A');
  await page.getByRole('button',{name:'Add markup',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await page.getByRole('button',{name:'Save new markup preset',exact:true}).click();
  await expect(page.getByText('1 preset(s) saved locally.',{exact:true})).toBeVisible();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export markup presets',exact:true}).click()]);
  const exported=JSON.parse(await readFile((await download.path())!,'utf8'));
  expect(exported.version).toBe(1);
  expect(Object.keys(exported.presets[0]).sort()).toEqual(['color','contents','id','kind','name','opacity','width']);
  await page.reload();
  await expect(page.getByLabel('Saved markup presets',{exact:true}).locator('option')).toHaveCount(2);
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'new.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await page.getByLabel('Markup tool',{exact:true}).selectOption('rectangle');
  await page.getByLabel('Markup contents',{exact:true}).fill('Existing note');
  await page.getByRole('button',{name:'Add markup',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await page.locator('.markup-list button').click();
  await page.getByLabel('Markup author',{exact:true}).fill('Engineer B');
  await page.getByLabel('Markup status',{exact:true}).selectOption('rejected');
  await page.getByLabel('Markup x1',{exact:true}).fill('60');
  await page.getByLabel('Saved markup presets',{exact:true}).selectOption(exported.presets[0].id);
  await page.getByRole('button',{name:'Apply selected preset',exact:true}).click();
  await expect(page.getByLabel('Markup tool',{exact:true})).toHaveValue('cloud');
  await expect(page.getByLabel('Markup contents',{exact:true})).toHaveValue('Review pipe spacing');
  await expect(page.getByLabel('Markup author',{exact:true})).toHaveValue('Engineer B');
  await expect(page.getByLabel('Markup status',{exact:true})).toHaveValue('rejected');
  await expect(page.getByLabel('Markup x1',{exact:true})).toHaveValue('60');
  await page.getByRole('button',{name:'Update selected markup',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Select a markup first');
  await expect(page.locator('.markup-list button')).toContainText('Existing note');
  await page.getByRole('button',{name:'Add markup',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(2);
  await page.getByRole('button',{name:'Clear local preset library',exact:true}).click();
  await page.getByLabel('Import markup presets',{exact:true}).setInputFiles({name:'presets.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});
  await expect(page.getByText('1 preset(s) saved locally.',{exact:true})).toBeVisible();
  await page.getByLabel('Saved markup presets',{exact:true}).selectOption(exported.presets[0].id);
  await page.getByLabel('Preset name',{exact:true}).fill('Revised pipe review');
  await page.getByRole('button',{name:'Replace selected preset',exact:true}).click();
  await expect(page.getByLabel('Saved markup presets',{exact:true}).locator('option')).toHaveCount(2);
  await page.getByRole('button',{name:'Delete selected preset',exact:true}).click();
  await expect(page.getByLabel('Saved markup presets',{exact:true}).locator('option')).toHaveCount(1);
  await expect(page.locator('.markup-list button')).toHaveCount(2);
});

test('invalid imports, duplicate presets and storage failures retain the prior library',async({page})=>{
  await openDrawing(page);
  await page.getByRole('button',{name:'Save new markup preset',exact:true}).click();
  await expect(page.getByText('1 preset(s) saved locally.',{exact:true})).toBeVisible();
  const prior=await page.evaluate(key=>localStorage.getItem(key),key);
  for(const payload of ['{"version":99,"presets":[]}',prior!,'{"version":1,"presets":[{}]}']){
    await page.getByLabel('Import markup presets',{exact:true}).setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(payload)});
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(prior);
    await expect(page.getByLabel('Saved markup presets',{exact:true}).locator('option')).toHaveCount(2);
  }
  await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Quota exceeded','QuotaExceededError');};});
  await page.getByLabel('Preset name',{exact:true}).fill('Another preset');
  await page.getByRole('button',{name:'Save new markup preset',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Quota');
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(prior);
  await expect(page.getByLabel('Saved markup presets',{exact:true}).locator('option')).toHaveCount(2);
});

test('unreadable stored library is preserved until explicitly cleared',async({page})=>{
  await page.addInitScript(key=>localStorage.setItem(key,'broken-json'),key);
  await page.goto('/');
  await expect(page.getByText(/Local preset library could not be read:/)).toBeVisible();
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe('broken-json');
  await page.getByRole('button',{name:'Clear local preset library',exact:true}).click();
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
  await expect(page.getByText('Local preset library cleared.',{exact:true})).toBeVisible();
});

test('a stale browser tab refuses to overwrite another tab library changes',async({page,context})=>{
  await openDrawing(page);
  const other=await context.newPage(); await other.goto('/');
  await page.getByRole('button',{name:'Save new markup preset',exact:true}).click();
  await expect(page.getByText('1 preset(s) saved locally.',{exact:true})).toBeVisible();
  await other.getByRole('button',{name:'Clear local preset library',exact:true}).click();
  await expect(other.getByRole('alert')).toContainText('changed in another tab');
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).presets.length,key)).toBe(1);
});

test('tool styles can be saved before opening a PDF without retaining entered drawing geometry',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Markup tool',{exact:true}).selectOption('callout');
  await page.getByLabel('Markup contents',{exact:true}).fill('Review clearance');
  await page.getByLabel('Markup x1',{exact:true}).fill('');
  await page.getByLabel('Callout leader points',{exact:true}).fill('unfinished geometry');
  await page.getByLabel('Preset name',{exact:true}).fill('Clearance callout');
  await page.getByRole('button',{name:'Save new markup preset',exact:true}).click();
  await expect(page.getByText('1 preset(s) saved locally.',{exact:true})).toBeVisible();
  const stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);
  expect(stored.presets[0].kind).toBe('callout');
  expect(stored.presets[0].points).toBeUndefined();
  expect(stored.presets[0].callout).toBeUndefined();
});
