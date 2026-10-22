import {test, expect, type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument, PDFName, PDFNumber, rgb} from 'pdf-lib';
// @ts-ignore authorized synthetic fixture shared with Node tests
import {drawingFixture} from '../fixture.mjs';

type Geometry = {x:number;y:number;width:number;height:number;userUnit:number};
const letter:Geometry = {x:0,y:0,width:612,height:792,userUnit:1};
const overlay = (page:Page) => page.getByTestId('measurement-overlay');

async function openFixture(page:Page,name='pointer-measurements.pdf',bytes?:Uint8Array) {
  await page.goto('/');
  const pdf = await PDFDocument.load(await drawingFixture());
  // An independent verification line: half the calibration distance on another part of the sheet.
  pdf.getPage(0).drawLine({start:{x:40,y:400},end:{x:184,y:400},thickness:2,color:rgb(0,0,0)});
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({
    name,mimeType:'application/pdf',buffer:Buffer.from(bytes ?? await pdf.save()),
  });
  await expect(overlay(page)).toBeVisible();
}

// Independent analytical quarter-turn mapping for this rectangular fixture. Deliberately
// does not import PDF.js or call the application's point conversion helper.
async function pick(page:Page,point:[number,number],rotation=0,zoom=1,geometry=letter) {
  const [x,y]=[point[0]-geometry.x,point[1]-geometry.y];
  const [u,v]=rotation===0?[x,geometry.height-y]:rotation===90?[y,x]:
    rotation===180?[geometry.width-x,y]:[geometry.height-y,geometry.width-x];
  await overlay(page).scrollIntoViewIfNeeded();
  const box=(await overlay(page).boundingBox())!;
  const factor=zoom*geometry.userUnit;
  await page.mouse.click(box.x+u*factor,box.y+v*factor);
}

async function fieldPoints(page:Page,label:string,expected:number[][]) {
  const raw=await page.getByLabel(label,{exact:true}).inputValue();
  const points=raw.trim().split(/[;\n]+/).map(pair=>pair.trim().split(',').map(Number));
  expect(points).toHaveLength(expected.length);
  points.forEach((point,index)=>point.forEach((value,axis)=>expect(value).toBeCloseTo(expected[index][axis],3)));
}

async function takeoff(page:Page) {
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export takeoff JSON',exact:true}).click();
  const file=await pending;
  return JSON.parse(await readFile((await file.path())!,'utf8')).takeoff;
}

test('picked calibration, independent verification and length retain PDF geometry through quarter turns and zoom',async({page})=>{
  await page.setViewportSize({width:1800,height:1200});
  await openFixture(page);
  await page.getByLabel('Markup tool',{exact:true}).selectOption('rectangle');
  for(let quarter=0;quarter<4;quarter++) {
    const rotation=quarter*90;
    if(quarter) await page.getByRole('button',{name:'Rotate page clockwise',exact:true}).click();
    if(quarter===1) await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    if(quarter===3) await page.getByRole('button',{name:'Zoom out',exact:true}).click();
    const zoom=quarter===1||quarter===2?1.25:1;
    await expect(page.locator('#zoom-label')).toHaveText(`${zoom*100}%`);
    await expect(overlay(page)).toBeVisible();
    await page.getByLabel('Review calibration reference',{exact:true}).check();
    await page.getByRole('button',{name:'Pick calibration points',exact:true}).click();
    await pick(page,[40,500],rotation,zoom);
    await pick(page,[328,500],rotation,zoom);
    await fieldPoints(page,'Calibration reference points',[[40,500],[328,500]]);
    await expect(page.getByLabel('Review calibration reference',{exact:true})).not.toBeChecked();
    // Drawing only stages coordinates: no scale or quantity silently enters the model.
    const draft=await takeoff(page);
    expect(draft.scales).toHaveLength(quarter?1:0);
    expect(draft.records).toHaveLength(quarter);
    await page.getByLabel('Known calibration distance',{exact:true}).fill('40');
    await page.getByLabel('Review calibration reference',{exact:true}).check();
    await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
    await page.getByLabel('Approve reviewed quantity changes',{exact:true}).check();
    await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
    await page.getByRole('button',{name:'Pick verification points',exact:true}).click();
    await pick(page,[40,400],rotation,zoom);
    await pick(page,[184,400],rotation,zoom);
    await fieldPoints(page,'Verification reference points',[[40,400],[184,400]]);
    await page.getByLabel('Known verification distance',{exact:true}).fill('20');
    await page.getByRole('button',{name:'Verify calibration',exact:true}).click();
    await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('verification passed');
    await page.getByLabel('Measurement label',{exact:true}).fill(`Quarter ${quarter}`);
    await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
    await pick(page,[40,500],rotation,zoom);
    await pick(page,[184,500],rotation,zoom);
    await fieldPoints(page,'Measurement points',[[40,500],[184,500]]);
    await page.getByRole('button',{name:'Add measurement',exact:true}).click();
    await expect(page.getByLabel('Measurement records',{exact:true})).toContainText(`Quarter ${quarter} · length: 20.000000 ft`);
    await expect(page.locator('.markup-list button')).toHaveCount(0);
  }
  const saved=await takeoff(page);
  expect(saved.records).toHaveLength(4);
  for(const record of saved.records) {
    expect(record.pageIndex).toBe(0);
    expect(record.points[0][0]).toBeCloseTo(40,3);
    expect(record.points[0][1]).toBeCloseTo(500,3);
    expect(record.points[1][0]).toBeCloseTo(184,3);
    expect(record.points[1][1]).toBeCloseTo(500,3);
  }
});

test('polygon draft supports undo point, explicit finish, Escape and page/tab cancellation without committing',async({page})=>{
  await page.setViewportSize({width:1800,height:1200});
  await openFixture(page);
  const original=await page.getByLabel('Measurement points',{exact:true}).inputValue();
  await page.getByLabel('Measurement type',{exact:true}).selectOption('area');
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  await pick(page,[40,500]);await pick(page,[112,500]);await pick(page,[112,428]);
  await page.keyboard.press('Backspace');
  await pick(page,[112,572]);await pick(page,[40,572]);
  await page.getByRole('button',{name:'Finish picking points',exact:true}).click();
  await fieldPoints(page,'Measurement points',[[40,500],[112,500],[112,572],[40,572]]);
  expect((await takeoff(page)).records).toEqual([]);
  const finished=await page.getByLabel('Measurement points',{exact:true}).inputValue();
  expect(finished).not.toBe(original);
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  await pick(page,[200,500]);
  await page.keyboard.press('Escape');
  await expect(overlay(page)).not.toHaveAttribute('data-picking','true');
  await expect(page.getByLabel('Measurement points',{exact:true})).toHaveValue(finished);
  // Failed Finish moves focus to its button; Escape must still discard that draft.
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  await pick(page,[200,500]);
  await page.getByRole('button',{name:'Finish picking points',exact:true}).click();
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('at least 3 points');
  await page.keyboard.press('Escape');
  await expect(overlay(page)).not.toHaveAttribute('data-picking','true');
  await expect(page.getByLabel('Measurement points',{exact:true})).toHaveValue(finished);
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  await pick(page,[200,500]);
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await expect(overlay(page)).not.toHaveAttribute('data-picking','true');
  expect((await takeoff(page)).records).toEqual([]);
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  // Opening a second document cancels the old document's draft even on the same page index.
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({
    name:'other.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture()),
  });
  await expect(page.locator('#document-name')).toHaveText('other.pdf');
  await expect(overlay(page)).not.toHaveAttribute('data-picking','true');
  expect((await takeoff(page)).records).toEqual([]);
});

test('picked points honor nonzero CropBox and UserUnit rather than full-page origin assumptions',async({page})=>{
  await page.setViewportSize({width:1800,height:1400});
  const pdf=await PDFDocument.load(await drawingFixture());
  const first=pdf.getPage(0);
  first.setCropBox(20,30,400,500);
  first.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));
  await openFixture(page,'crop-unit.pdf',await pdf.save());
  await page.getByRole('button',{name:'Pick calibration points',exact:true}).click();
  const geometry={x:20,y:30,width:400,height:500,userUnit:2};
  await pick(page,[40,500],0,1,geometry);
  await pick(page,[328,500],0,1,geometry);
  await fieldPoints(page,'Calibration reference points',[[40,500],[328,500]]);
  expect((await takeoff(page)).scales).toEqual([]);
});

test('picks snap to exact existing measurement points, Shift constrains on screen and snapping can be disabled',async({page})=>{
  await page.setViewportSize({width:1800,height:1200});
  await openFixture(page);
  await page.getByLabel('Calibration reference points',{exact:true}).fill('40,500;328,500');
  await page.getByLabel('Known calibration distance',{exact:true}).fill('40');
  await page.getByLabel('Review calibration reference',{exact:true}).check();
  await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
  await page.getByLabel('Approve reviewed quantity changes',{exact:true}).check();
  await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
  await page.getByLabel('Verification reference points',{exact:true}).fill('40,400;184,400');
  await page.getByLabel('Known verification distance',{exact:true}).fill('20');
  await page.getByRole('button',{name:'Verify calibration',exact:true}).click();
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('verification passed');
  await page.getByLabel('Measurement points',{exact:true}).fill('40.25,500.5;184,500');
  await page.getByLabel('Measurement label',{exact:true}).fill('Existing');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  await expect(page.getByLabel('Measurement records',{exact:true})).toContainText('Existing');
  await page.getByRole('button',{name:'Rotate page clockwise',exact:true}).click();
  await expect(overlay(page)).toBeVisible();
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  // 4-5 screen pixels away from stored vertices: exact stored coordinates are reused.
  await pick(page,[43,503],90);
  await pick(page,[187,497],90);
  expect(await page.getByLabel('Measurement points',{exact:true}).inputValue()).toBe('40.25,500.5;184,500');
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('Picked coordinates are ready');
  // Shift on a quarter-turned page: screen-horizontal is PDF-vertical.
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  await pick(page,[300,300],90);
  await page.keyboard.down('Shift');
  await pick(page,[310,450],90);
  await page.keyboard.up('Shift');
  await fieldPoints(page,'Measurement points',[[300,300],[300,450]]);
  await page.getByLabel('Snap picks to existing measurement points',{exact:true}).uncheck();
  await page.getByLabel('Snap picks to drawing endpoints, midpoints and intersections',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Pick measurement points',exact:true}).click();
  await pick(page,[43,503],90);
  await pick(page,[187,497],90);
  await fieldPoints(page,'Measurement points',[[43,503],[187,497]]);
  expect((await takeoff(page)).records).toHaveLength(1);
});

test('picks snap to painted drawing line endpoints at zoom and the option can be disabled',async({page})=>{
  await page.setViewportSize({width:1800,height:1200});
  await openFixture(page);
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await expect(page.locator('#zoom-label')).toHaveText('125%');
  await expect(overlay(page)).toBeVisible();
  await page.getByRole('button',{name:'Pick calibration points',exact:true}).click();
  // Fixture lines run 40,500→328,500 and 40,400→184,400; picks are ~5 screen px off. 4 endpoints + 2 segment midpoints.
  await expect(overlay(page)).toHaveAttribute('data-drawing-vertices','6');
  await pick(page,[43,503],0,1.25);
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('snapped');
  await pick(page,[325,498],0,1.25);
  expect(await page.getByLabel('Calibration reference points',{exact:true}).inputValue()).toBe('40,500;328,500');
  await page.getByLabel('Snap picks to drawing endpoints, midpoints and intersections',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Pick verification points',exact:true}).click();
  await pick(page,[43,403],0,1.25);
  await pick(page,[181,402],0,1.25);
  await fieldPoints(page,'Verification reference points',[[43,403],[181,402]]);
});

test('measurement presets fill the form only, persist across reload and derived quantities are recorded',async({page})=>{
  await page.setViewportSize({width:1800,height:1200});
  await openFixture(page);
  await page.getByLabel('Calibration reference points',{exact:true}).fill('40,500;328,500');
  await page.getByLabel('Known calibration distance',{exact:true}).fill('40');
  await page.getByLabel('Review calibration reference',{exact:true}).check();
  await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
  await page.getByLabel('Approve reviewed quantity changes',{exact:true}).check();
  await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
  await page.getByLabel('Measurement type',{exact:true}).selectOption('length');
  await page.getByLabel('Measurement label',{exact:true}).fill('Curb');
  await page.getByLabel('Quantity multiplier',{exact:true}).fill('2');
  await page.getByLabel('Waste percent',{exact:true}).fill('10');
  await page.getByLabel('Derived quantity unit',{exact:true}).fill('blocks');
  await page.getByLabel('New preset name',{exact:true}).fill('Curb blocks');
  await page.getByRole('button',{name:'Save measurement preset',exact:true}).click();
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('Preset Curb blocks saved');
  expect((await takeoff(page)).records).toEqual([]);
  await page.reload();
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'again.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(overlay(page)).toBeVisible();
  await page.getByLabel('Calibration reference points',{exact:true}).fill('40,500;328,500');
  await page.getByLabel('Known calibration distance',{exact:true}).fill('40');
  await page.getByLabel('Review calibration reference',{exact:true}).check();
  await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
  await page.getByLabel('Approve reviewed quantity changes',{exact:true}).check();
  await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
  await page.getByLabel('Measurement preset',{exact:true}).selectOption('Curb blocks');
  await page.getByRole('button',{name:'Apply measurement preset',exact:true}).click();
  await expect(page.getByLabel('Measurement label',{exact:true})).toHaveValue('Curb');
  await expect(page.getByLabel('Quantity multiplier',{exact:true})).toHaveValue('2');
  await page.getByLabel('Measurement points',{exact:true}).fill('40,500;184,500');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  await expect(page.getByLabel('Measurement records',{exact:true})).toContainText('Curb · length: 20.000000 ft → 44.000000 blocks');
  const [record]=(await takeoff(page)).records;
  expect(record.quantity).toEqual({multiplier:2,wastePercent:10,unitLabel:'blocks'});
  await page.getByLabel('Quantity multiplier',{exact:true}).fill('');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('Enter a quantity multiplier');
  await page.getByRole('button',{name:'Delete measurement preset',exact:true}).click();
  await expect(page.getByLabel('Measurement preset',{exact:true}).locator('option')).toHaveCount(0);
});

test('measured PDF export writes standard dimension annotations to a copy',async({page})=>{
  await page.setViewportSize({width:1800,height:1200});
  await openFixture(page);
  await page.getByLabel('Calibration reference points',{exact:true}).fill('40,500;328,500');
  await page.getByLabel('Known calibration distance',{exact:true}).fill('40');
  await page.getByLabel('Review calibration reference',{exact:true}).check();
  await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
  await page.getByLabel('Approve reviewed quantity changes',{exact:true}).check();
  await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
  await page.getByLabel('Measurement label',{exact:true}).fill('Wall');
  await page.getByLabel('Measurement points',{exact:true}).fill('40,500;184,500');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  await page.getByLabel('Measurement type',{exact:true}).selectOption('count');
  await page.getByLabel('Measurement points',{exact:true}).fill('10,10');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export PDF with measurement annotations',exact:true}).click();
  const file=await pending;
  expect(file.suggestedFilename()).toBe('pointer-measurements-measured.pdf');
  await expect(page.locator('#status')).toContainText('1 measurement annotation(s); 1 angle/count measurement(s) omitted');
  const bytes=await readFile((await file.path())!);
  if(process.env.OPENDRAFT_MEASURED_OUT)await (await import('node:fs/promises')).writeFile(process.env.OPENDRAFT_MEASURED_OUT,bytes);
  const pdf=await PDFDocument.load(bytes);
  const annot=pdf.context.lookup(pdf.getPage(0).node.Annots()!.get(0)) as any;
  expect(annot.get(PDFName.of('Subtype')).toString()).toBe('/Line');
  expect(annot.get(PDFName.of('IT')).toString()).toBe('/LineDimension');
  expect(annot.lookup(PDFName.of('Contents')).decodeText()).toBe('Wall: 20 ft');
});
