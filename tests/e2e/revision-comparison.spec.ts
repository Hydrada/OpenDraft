import {test, expect, type Page} from '@playwright/test';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, degrees, rgb} from 'pdf-lib';

async function drawing(kind: 'base' | 'revision' | 'shift' | 'large' | 'rotated' | 'unit') {
  const pdf = await PDFDocument.create({updateMetadata: false});
  const page = pdf.addPage(kind === 'large' ? [3000, 3000] : [200, 160]);
  const dx = kind === 'shift' ? 10 : 0;
  page.drawRectangle({x: 20 + dx, y: 100, width: 40, height: 20, color: rgb(0, 0, 0)});
  if (kind === 'base' || kind === 'shift') page.drawRectangle({x: 80 + dx, y: 100, width: 20, height: 20, color: rgb(0, 0, 0)});
  if (kind === 'revision') page.drawRectangle({x: 120, y: 40, width: 20, height: 20, color: rgb(0, 0, 0)});
  if (kind === 'rotated') { page.setCropBox(10, 20, 160, 120); page.setRotation(degrees(90)); }
  if (kind === 'unit') { page.setCropBox(10, 20, 160, 120); page.node.set(PDFName.of('UserUnit'), pdf.context.obj(2)); }
  return Buffer.from(await pdf.save());
}
async function open(page: Page, documents: {name: string; buffer: Buffer}[]) {
  await page.goto('/');
  await expect(page.getByLabel('Open PDF files', {exact: true})).toBeEnabled();
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles(documents.map(d => ({...d, mimeType: 'application/pdf'})));
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(documents.length);
  await expect(page.locator('#page canvas')).toBeVisible();
  await page.getByRole('button', {name: 'Compare drawing revisions', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Drawing revision comparison'})).toBeVisible();
}
async function choose(page: Page, base: string, revision: string) {
  await page.getByLabel('Comparison base document', {exact: true}).selectOption({label: base});
  await page.getByLabel('Comparison revision document', {exact: true}).selectOption({label: revision});
}
async function compare(page: Page) {
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('Comparison ready');
  await expect(page.getByRole('button', {name: 'Compare pages', exact: true})).toBeEnabled();
}
async function exported(page: Page, name: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click()]);
  return readFile((await download.path())!);
}
async function pixel(page: Page, x: number, y: number) {
  return page.getByLabel('Drawing comparison image', {exact: true}).evaluate((surface: HTMLCanvasElement, point) => [...surface.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data], {x, y});
}
async function proposeClouds(page:Page){
  await page.getByRole('button',{name:'Propose difference clouds',exact:true}).click();
  await expect(page.getByLabel('Difference cloud review',{exact:true})).toBeVisible();
}
async function addClouds(page:Page,ids=[1,2]){
  for(const id of ids)await page.getByLabel(`Include difference region ${id}`,{exact:true}).check();
  await page.getByLabel('Approve selected difference clouds',{exact:true}).check();
  await page.getByRole('button',{name:'Add selected clouds to base drawing',exact:true}).click();
  await expect(page.getByLabel('Difference cloud status',{exact:true})).toContainText(`Added ${ids.length} reviewed cloud annotations`);
}

test('revision comparison exports known changes and immutable snapshot evidence with matching colors and PDF size', async ({page}) => {
  const base = await drawing('base'), revision = await drawing('revision');
  await open(page, [{name: 'base.pdf', buffer: base}, {name: 'revision.pdf', buffer: revision}]);
  await choose(page, 'base.pdf', 'revision.pdf'); await compare(page);
  expect(await pixel(page, 85, 45)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 125, 105)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 25, 45)).toEqual([0, 0, 0, 255]);
  const evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.base.sha256).toBe(createHash('sha256').update(base).digest('hex'));
  expect(evidence.revision.sha256).toBe(createHash('sha256').update(revision).digest('hex'));
  expect(evidence.comparison).toMatchObject({width: 200, height: 160, changedPixels: 800, totalPixels: 32000, changedBounds: {x: 80, y: 40, width: 60, height: 80}});
  await page.getByLabel('Comparison view', {exact: true}).selectOption('difference');
  expect(await pixel(page, 85, 45)).toEqual([220, 35, 45, 255]);
  expect(await pixel(page, 125, 105)).toEqual([25, 80, 220, 255]);
  expect(await pixel(page, 25, 45)).toEqual([224, 224, 224, 255]);
  const image = await exported(page, 'Export comparison PNG');
  expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(image.readUInt32BE(16)).toBe(200); expect(image.readUInt32BE(20)).toBe(160);
  const pdfBytes = await exported(page, 'Export comparison PDF');
  const pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getPageCount()).toBe(1); expect(pdf.getPage(0).getSize()).toEqual({width: 200, height: 160});
  expect(pdf.getTitle()).toContain('raster revision difference');
  const attachmentNames = pdf.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
  const file = attachmentNames.lookup(1, PDFDict).lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFRawStream);
  const attached = JSON.parse(new TextDecoder().decode(decodePDFRawStream(file).decode()));
  expect(attached.base.sha256).toBe(evidence.base.sha256); expect(attached.exportedView).toBe('difference');
  expect(attached.comparison.changedPixels).toBe(800);
  const folder = path.join(tmpdir(), 'opendraft-revision-export-validation');
  await mkdir(folder, {recursive: true});
  const json = await exported(page, 'Export comparison evidence JSON');
  await Promise.all([['revision-difference.pdf', pdfBytes], ['revision-difference.png', image], ['revision-comparison.json', json], ['base.pdf', base], ['revision.pdf', revision]].map(([name, bytes]) => writeFile(path.join(folder, name as string), bytes)));
  await page.getByRole('button', {name: 'Close comparison', exact: true}).click();
  expect(await exported(page, 'Save PDF')).toEqual(revision);
  await page.getByRole('button', {name: 'View base.pdf', exact: true}).click();
  expect(await exported(page, 'Save PDF')).toEqual(base);
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
});

test('reviewed difference clouds commit to base only, export provenance and survive atomic undo/recovery/flattening',async({page})=>{
  const base=await drawing('base'),revision=await drawing('revision');
  await open(page,[{name:'base.pdf',buffer:base},{name:'revision.pdf',buffer:revision}]);
  await choose(page,'base.pdf','revision.pdf');await compare(page);
  const beforePreview=await exported(page,'Export comparison PNG');await proposeClouds(page);
  await expect(page.getByLabel('Difference cloud status',{exact:true})).toContainText('No annotations added');
  await expect(page.getByRole('button',{name:'Add selected clouds to base drawing',exact:true})).toBeDisabled();
  expect(await exported(page,'Export comparison PNG')).toEqual(beforePreview);
  await addClouds(page);
  await page.getByRole('button',{name:'Close comparison',exact:true}).click();
  expect(await exported(page,'Save PDF')).toEqual(revision);
  await page.getByRole('button',{name:'View base.pdf',exact:true}).click();
  const output=await exported(page,'Save PDF'),pdf=await PDFDocument.load(output),annotations=pdf.getPage(0).node.Annots()!.asArray().map(ref=>pdf.context.lookup(ref,PDFDict));
  expect(annotations).toHaveLength(2);
  const evidence=annotations.map(annot=>JSON.parse(annot.lookup(PDFName.of('Contents')).decodeText()));
  expect(evidence.map(item=>item.region.pdfBounds)).toEqual([[76,96,104,124],[116,36,144,64]]);
  for(const [index,annot] of annotations.entries()){
    expect(annot.lookup(PDFName.of('Subtype')).toString()).toBe('/Square');
    expect(annot.lookup(PDFName.of('BE'),PDFDict).lookup(PDFName.of('S')).toString()).toBe('/C');
    expect(evidence[index]).toMatchObject({schema:'opendraft.difference-cloud',version:1,threshold:16,base:{sha256:createHash('sha256').update(base).digest('hex'),page:1},revision:{sha256:createHash('sha256').update(revision).digest('hex'),page:1}});
  }
  const folder=path.join(tmpdir(),'opendraft-difference-cloud-validation');await mkdir(folder,{recursive:true});
  const flat=await exported(page,'Flatten OpenDraft markups');
  await Promise.all([writeFile(path.join(folder,'base.pdf'),base),writeFile(path.join(folder,'revision.pdf'),revision),writeFile(path.join(folder,'clouds.pdf'),output),writeFile(path.join(folder,'flattened.pdf'),flat),writeFile(path.join(folder,'expected.json'),JSON.stringify({bounds:[[76,96,104,124],[116,36,144,64]],count:2}))]);
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();expect(await exported(page,'Save PDF')).toEqual(base);
  await expect(page.getByRole('button',{name:'Undo edit',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Redo edit',exact:true}).click();
  await expect(page.locator('.markup-list')).toContainText('cloud');
  await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();
  await expect(page.locator('#recovery-status')).toHaveText('Recovery saved locally');await page.reload();
  await page.getByRole('button',{name:'Restore retained session',exact:true}).click();
  await expect(page.locator('.markup-list')).toContainText('cloud');
  await expect(page.locator('.markup-list button')).toHaveCount(2);
});

test('cloud selection and comparison edits revoke approval; stale source snapshots cannot commit',async({page})=>{
  await open(page,[{name:'base.pdf',buffer:await drawing('base')},{name:'revision.pdf',buffer:await drawing('revision')}]);
  await choose(page,'base.pdf','revision.pdf');await compare(page);await proposeClouds(page);
  await page.getByLabel('Include difference region 1',{exact:true}).check();
  await page.getByLabel('Approve selected difference clouds',{exact:true}).check();
  await page.getByLabel('Include difference region 2',{exact:true}).check();
  await expect(page.getByLabel('Approve selected difference clouds',{exact:true})).not.toBeChecked();
  await page.getByLabel('Cloud margin points',{exact:true}).fill('0');
  await expect(page.getByLabel('Difference cloud review',{exact:true})).toBeHidden();
  await proposeClouds(page);await page.getByLabel('Include difference region 1',{exact:true}).check();
  await page.getByLabel('Approve selected difference clouds',{exact:true}).check();
  // Exercise a source edit arriving outside the modal. The active source is revision.pdf.
  await page.evaluate(()=>document.querySelector<HTMLButtonElement>('#rotate')!.click());
  await expect(page.locator('#status')).not.toContainText('Updating');
  await expect.poll(()=>page.locator('#page canvas').evaluate((canvas:HTMLCanvasElement)=>canvas.height>canvas.width)).toBe(true);
  await page.getByRole('button',{name:'Add selected clouds to base drawing',exact:true}).click();
  await expect(page.getByLabel('Difference cloud error',{exact:true})).toContainText('sources changed');
  await expect(page.getByLabel('Approve selected difference clouds',{exact:true})).not.toBeChecked();
  await page.getByLabel('Comparison threshold',{exact:true}).fill('17');
  await expect(page.getByLabel('Comparison result',{exact:true})).toBeHidden();
});

test('cloud PDF bounds honor actual rotated CropBox and UserUnit viewport geometry',async({page})=>{
  async function cropped(kind:'base'|'revision'){
    const doc=await PDFDocument.load(await drawing(kind)),sheet=doc.getPage(0);sheet.setCropBox(10,20,160,120);sheet.setRotation(degrees(90));sheet.node.set(PDFName.of('UserUnit'),doc.context.obj(2));return Buffer.from(await doc.save());
  }
  await open(page,[{name:'base.pdf',buffer:await cropped('base')},{name:'revision.pdf',buffer:await cropped('revision')}]);
  await choose(page,'base.pdf','revision.pdf');await compare(page);await proposeClouds(page);await addClouds(page);
  await page.getByRole('button',{name:'Close comparison',exact:true}).click();await page.getByRole('button',{name:'View base.pdf',exact:true}).click();
  const output=await PDFDocument.load(await exported(page,'Save PDF'));
  const bounds=output.getPage(0).node.Annots()!.asArray().map(ref=>JSON.parse(output.context.lookup(ref,PDFDict).lookup(PDFName.of('Contents')).decodeText()).region.pdfBounds);
  expect(bounds).toEqual([[78,98,102,122],[118,38,142,62]]);
});

test('adding a selected cloud preserves existing calibrated takeoff and leaves unselected regions absent',async({page})=>{
  await open(page,[{name:'base.pdf',buffer:await drawing('base')},{name:'revision.pdf',buffer:await drawing('revision')}]);
  await page.getByRole('button',{name:'Close comparison',exact:true}).click();await page.getByRole('button',{name:'View base.pdf',exact:true}).click();
  await page.getByLabel('Known calibration distance',{exact:true}).fill('10');
  await page.getByLabel('Review calibration reference',{exact:true}).check();await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
  await page.getByLabel('Measurement label',{exact:true}).fill('Preserved calibrated run');await page.getByLabel('Measurement points',{exact:true}).fill('0,0;144,0');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  const before=JSON.parse((await exported(page,'Export takeoff JSON')).toString());
  await page.getByRole('button',{name:'Compare drawing revisions',exact:true}).click();await choose(page,'base.pdf','revision.pdf');await compare(page);await proposeClouds(page);await addClouds(page,[2]);
  await page.getByRole('button',{name:'Close comparison',exact:true}).click();
  const after=JSON.parse((await exported(page,'Export takeoff JSON')).toString());
  expect(before.takeoff.scales).toHaveLength(1);expect(before.takeoff.records).toHaveLength(1);
  expect(after.takeoff).toEqual(before.takeoff);
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  const output=await PDFDocument.load(await exported(page,'Save PDF'));
  expect(output.getPage(0).node.Annots()!.size()).toBe(1);
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();
  expect(JSON.parse((await exported(page,'Export takeoff JSON')).toString()).takeoff).toEqual(before.takeoff);
});

test('manual translation rounds explicitly, invalidates stale exports and supports threshold changes', async ({page}) => {
  await open(page, [{name: 'base.pdf', buffer: await drawing('base')}, {name: 'shifted.pdf', buffer: await drawing('shift')}]);
  await choose(page, 'base.pdf', 'shifted.pdf'); await compare(page);
  let evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.comparison.changedPixels).toBeGreaterThan(0);
  await page.getByLabel('Revision horizontal offset', {exact: true}).fill('-10.2');
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
  await compare(page);
  evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.alignment).toMatchObject({requestedPoints: {x: -10.2, y: 0}, appliedPixels: {x: -10, y: 0}, appliedPoints: {x: -10, y: 0}});
  expect(evidence.comparison).toMatchObject({width: 210, height: 160, originX: -10, changedPixels: 0, changedBounds: null});
  await page.getByLabel('Revision horizontal offset', {exact: true}).fill('0');
  await page.getByLabel('Comparison threshold', {exact: true}).fill('255'); await compare(page);
  evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.comparison.changedPixels).toBe(0);
  await page.getByLabel('Comparison threshold', {exact: true}).fill('256');
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison error', {exact: true})).toContainText('Threshold');
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
});

test('resource rejection precedes rendering; cancellation and closing discard work without stale results', async ({page}) => {
  await open(page, [{name: 'large.pdf', buffer: await drawing('large')}]);
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison error', {exact: true})).toContainText('budget');
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
  await page.getByLabel('Comparison resolution', {exact: true}).selectOption('36');
  // Cancel immediately after dispatch, while the isolated worker is still loading.
  await page.evaluate(() => {
    (document.querySelector('[data-action="run"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
  });
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('cancelled');
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
  await expect(page.getByRole('button', {name: 'Compare pages', exact: true})).toBeEnabled();
  await page.evaluate(() => {
    (document.querySelector('[data-action="run"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="close"]') as HTMLButtonElement).click();
  });
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', {name: 'Compare drawing revisions', exact: true}).click();
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
  // Successful rerun proves cancelled task cleanup does not poison the next snapshot.
  await compare(page);
  const evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.comparison).toMatchObject({width: 1500, height: 1500, changedPixels: 0});
  const pdf = await PDFDocument.load(await exported(page, 'Export comparison PDF'));
  expect(pdf.getPage(0).getSize()).toEqual({width: 3000, height: 3000});
});

test('rotated CropBox and UserUnit are reported and rendered at physical point resolution', async ({page}) => {
  await open(page, [{name: 'rotated.pdf', buffer: await drawing('rotated')}, {name: 'unit.pdf', buffer: await drawing('unit')}]);
  await choose(page, 'rotated.pdf', 'rotated.pdf'); await compare(page);
  let evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.base).toMatchObject({width: 120, height: 160, rotation: 90, viewBox: [10, 20, 170, 140]});
  expect(evidence.comparison.changedPixels).toBe(0);
  await choose(page, 'unit.pdf', 'unit.pdf'); await compare(page);
  evidence = JSON.parse((await exported(page, 'Export comparison evidence JSON')).toString());
  expect(evidence.base).toMatchObject({width: 320, height: 240, userUnit: 2, viewBox: [10, 20, 170, 140]});
  expect(evidence.comparison.changedPixels).toBe(0);
  await page.getByLabel('Comparison base page', {exact: true}).fill('2');
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison error', {exact: true})).toContainText('valid page');
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
});
