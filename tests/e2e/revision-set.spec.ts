import {test, expect, type Page} from '@playwright/test';
import {PDFDocument, PDFName, PDFDict, PDFHexString, rgb} from 'pdf-lib';
import {unzipSync, strFromU8} from 'fflate';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

type Drawing = {name: string; bytes: Buffer};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function drawing(name: string, code: string, revised = false, large = false): Promise<Drawing> {
  const pdf = await PDFDocument.create({updateMetadata: false}), N = PDFName.of;
  pdf.setTitle(`${code} ${revised ? 'revision' : 'original'}`); pdf.setAuthor('Authorized synthetic reviewer'); pdf.setProducer('Original fixture producer');
  pdf.setCreationDate(new Date('2001-02-03T04:05:06Z')); pdf.setModificationDate(new Date('2002-03-04T05:06:07Z'));
  const pages = Array.from({length: 2}, (_, index) => {
    const page = pdf.addPage(large ? [500, 400] : [400, 300]);
    page.drawText(`${code} ${revised ? 'REVISED' : 'ORIGINAL'} SHEET ${index + 1}`, {x: 30, y: 250, size: 16});
    page.drawRectangle({x: revised ? 250 : 40, y: 55 + index * 25, width: 40, height: 30, color: revised ? rgb(1, 0, 0) : rgb(0, 0, 0)});
    page.node.addAnnot(pdf.context.register(pdf.context.obj({Type: 'Annot', Subtype: 'Text', Rect: [5, 5, 15, 15], Contents: PDFHexString.fromText(`${code} ${revised ? 'donor' : 'base'} note ${index + 1}`), NM: PDFHexString.fromText(`${revised ? 'donor' : 'base'}-note-${index + 1}`), P: page.ref, F: 4})));
    return page;
  });
  pdf.catalog.set(N('PageLabels'), pdf.context.obj({Nums: [0, {P: PDFHexString.fromText(`${code}1`)}, 1, {P: PDFHexString.fromText(`${code}2`)}]}));
  if (!revised) {
    pages[0].node.addAnnot(pdf.context.register(pdf.context.obj({Type: 'Annot', Subtype: 'Link', Rect: [20, 210, 140, 225], Border: [0, 0, 0], Dest: [pages[1].ref, 'Fit'], NM: PDFHexString.fromText('base-reference-link'), P: pages[0].ref})));
    pages[1].node.addAnnot(pdf.context.register(pdf.context.obj({Type: 'Annot', Subtype: 'Link', Rect: [20, 210, 140, 225], Border: [0, 0, 0], A: {S: 'GoTo', D: [0, 'Fit']}, NM: PDFHexString.fromText('base-numeric-link'), P: pages[1].ref})));
    const field = pdf.getForm().createTextField('AssetCode'); field.setText(`${code}-checked`); field.addToPage(pages[0], {x: 90, y: 20, width: 120, height: 25});
    await pdf.attach(new TextEncoder().encode(`${code} authorized attachment\n`), 'reference.txt', {mimeType: 'text/plain'}); await pdf.flush();
    const names = pdf.catalog.lookup(N('Names'), PDFDict); names.set(N('Dests'), pdf.context.obj({Names: [PDFHexString.fromText('original-sheet'), [pages[0].ref, 'Fit']]}));
    const outlines = pdf.context.register(pdf.context.obj({Type: 'Outlines', Count: 1}));
    const first = pdf.context.register(pdf.context.obj({Title: PDFHexString.fromText('Original first sheet'), Parent: outlines, Dest: [pages[0].ref, 'Fit']}));
    const root = pdf.context.lookup(outlines, PDFDict); root.set(N('First'), first); root.set(N('Last'), first); pdf.catalog.set(N('Outlines'), outlines);
  }
  return {name, bytes: Buffer.from(await pdf.save({updateFieldAppearances: false}))};
}
async function files(page: Page, label: string, drawings: Drawing[]) {
  await page.getByLabel(label, {exact: true}).setInputFiles(drawings.map(item => ({name: item.name, mimeType: 'application/pdf', buffer: item.bytes})));
}
async function openSet(page: Page, current: Drawing[], revision: Drawing[], workspace?: Drawing) {
  await page.goto('/'); await expect(page.getByLabel('Open PDF files', {exact: true})).toBeEnabled();
  if (workspace) {
    await files(page, 'Open PDF files', [workspace]);
    await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(1);
    await expect(page.locator('#page canvas')).toBeVisible();
  }
  await page.getByRole('button', {name: 'Revise drawing set', exact: true}).click();
  await files(page, 'Current drawing files', current); await files(page, 'Revision drawing files', revision);
  await page.getByLabel('Drawing set pairing strategy', {exact: true}).selectOption('order');
  await page.getByLabel('Drawing set reason', {exact: true}).fill('Issued coordinated drawing set R9');
}
async function prepare(page: Page) {
  await page.getByRole('button', {name: 'Prepare drawing set', exact: true}).click();
  await expect(page.getByLabel('Revision file for current drawing 1', {exact: true})).toBeVisible();
}
async function apply(page: Page) {
  await page.getByLabel('Approve drawing set impact', {exact: true}).check();
  await page.getByRole('button', {name: 'Apply reviewed drawing set', exact: true}).click();
  await expect(page.getByLabel('Drawing set status', {exact: true})).toContainText('Drawing set finished:');
  await expect(page.getByRole('button', {name: 'Download revised drawing set ZIP', exact: true})).toBeVisible();
}
async function download(page: Page, name: string) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click()]);
  return readFile((await file.path())!);
}
async function importSetPlan(page:Page,plan:unknown,name='set-plan.json') {
  await page.getByLabel('Import drawing set plan',{exact:true}).setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(plan))});
}
async function evidence(scenario: string, zip: Buffer, base: Drawing[], revision: Drawing[], statuses: string[], operation = 'replace') {
  const dir = path.join(tmpdir(), 'opendraft-revision-set-validation', scenario); await mkdir(dir, {recursive: true});
  const jobs = base.map((item, index) => ({baseFile: `base-${index + 1}.pdf`, revisionFile: `revision-${index + 1}.pdf`, baseName: item.name, revisionName: revision[index].name, status: statuses[index], outputPath: statuses[index] === 'succeeded' ? `PDFs/${String(index + 1).padStart(4, '0')}.pdf` : null, code: ['A', 'B'][index]}));
  await Promise.all([writeFile(path.join(dir, 'set.zip'), zip), writeFile(path.join(dir, 'expected.json'), JSON.stringify({operation, jobs})), ...base.map((item, index) => writeFile(path.join(dir, `base-${index + 1}.pdf`), item.bytes)), ...revision.map((item, index) => writeFile(path.join(dir, `revision-${index + 1}.pdf`), item.bytes))]);
}

test('two matching files revise independently with retained source annotations and untouched workspace', async ({page}) => {
  const base = await Promise.all([drawing('A.pdf', 'A'), drawing('B.pdf', 'B')]);
  const revision = await Promise.all([drawing('A.pdf', 'A', true), drawing('B.pdf', 'B', true)]);
  const workspace = await drawing('workspace.pdf', 'WORKSPACE');
  await openSet(page, base, revision, workspace); await prepare(page); await apply(page);
  const zip = await download(page, 'Download revised drawing set ZIP'), entries = unzipSync(zip), manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.schema).toBe('opendraft.revision-set'); expect(manifest.version).toBe(1);
  expect(manifest.results.map((item: any) => item.status)).toEqual(['succeeded', 'succeeded']);
  for (let index = 0; index < 2; index++) {
    expect(manifest.results[index]).toMatchObject({base: {sha256: hash(base[index].bytes)}, revision: {sha256: hash(revision[index].bytes)}, outputPath: `PDFs/${String(index + 1).padStart(4, '0')}.pdf`, outputPageCount: 2});
    expect(hash(entries[manifest.results[index].outputPath])).toBe(manifest.results[index].outputSha256);
  }
  await evidence('replace', zip, base, revision, ['succeeded', 'succeeded']);
  await page.getByRole('button', {name: 'Close drawing set', exact: true}).click();
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(1);
  expect(await download(page, 'Save PDF')).toEqual(workspace.bytes);
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
});

test('one geometry mismatch produces an explicit file failure while the other revised PDF remains downloadable', async ({page}) => {
  const base = await Promise.all([drawing('A.pdf', 'A'), drawing('B.pdf', 'B')]);
  const revision = await Promise.all([drawing('A.pdf', 'A', true), drawing('B.pdf', 'B', true, true)]);
  await openSet(page, base, revision); await prepare(page); await apply(page);
  const zip = await download(page, 'Download revised drawing set ZIP'), entries = unzipSync(zip), manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.results.map((item: any) => item.status)).toEqual(['succeeded', 'failed']);
  expect(manifest.results[1].error).toMatch(/geometry/i);
  expect(Object.keys(entries).sort()).toEqual(['PDFs/0001.pdf', 'manifest.json', 'summary.csv']);
  await evidence('partial', zip, base, revision, ['succeeded', 'failed']);
});

test('insert-before revises both files while retaining old sheets and superseded stamps in each output', async ({page}) => {
  const base = await Promise.all([drawing('A.pdf', 'A'), drawing('B.pdf', 'B')]);
  const revision = await Promise.all([drawing('A.pdf', 'A', true), drawing('B.pdf', 'B', true)]);
  await openSet(page, base, revision);
  await page.getByLabel('Drawing set operation', {exact: true}).selectOption('insert-before');
  await prepare(page); await apply(page);
  const zip = await download(page, 'Download revised drawing set ZIP'), entries = unzipSync(zip), manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.results.map((item: any) => item.status)).toEqual(['succeeded', 'succeeded']);
  for (const result of manifest.results) {
    const output = await PDFDocument.load(entries[result.outputPath]); expect(output.getPageCount()).toBe(4);
    for (const index of [1, 3]) {
      const annotations = output.getPage(index).node.Annots()!.asArray().map(ref => output.context.lookup(ref));
      expect(annotations.some((item: any) => item.get(PDFName.of('Subtype'))?.toString() === '/Stamp' && item.get(PDFName.of('Contents'))?.decodeText() === 'SUPERSEDED')).toBe(true);
    }
  }
  await evidence('insert', zip, base, revision, ['succeeded', 'succeeded'], 'insert-before');
});

test('ambiguous duplicate basenames need explicit pairing; cancellation and changed settings discard approval and exports', async ({page}) => {
  const base = await Promise.all([drawing('same.pdf', 'A'), drawing('same.pdf', 'B')]);
  const revision = await Promise.all([drawing('same.pdf', 'A', true), drawing('same.pdf', 'B', true)]);
  await openSet(page, base, revision); await prepare(page);
  const first = page.getByLabel('Revision file for current drawing 1', {exact: true}), second = page.getByLabel('Revision file for current drawing 2', {exact: true});
  expect(await first.inputValue()).toBe(await first.locator('option').first().getAttribute('value'));
  expect(await second.inputValue()).toBe(await second.locator('option').first().getAttribute('value'));
  await first.selectOption({index: 1}); await second.selectOption({index: 2});
  await expect(page.getByLabel('Revision sheet for drawing 1 page 1', {exact: true})).toBeVisible();
  await page.getByLabel('Approve drawing set impact', {exact: true}).check();
  await page.evaluate(() => {
    const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === name)!;
    button('Apply reviewed drawing set').click(); button('Cancel drawing set').click();
  });
  await expect(page.getByLabel('Drawing set status', {exact: true})).toContainText(/cancel/i);
  await expect(page.getByRole('button', {name: 'Download revised drawing set ZIP', exact: true})).not.toBeVisible();
  await prepare(page);
  await first.selectOption({index: 1}); await second.selectOption({index: 2});
  await apply(page);
  await page.getByLabel('Drawing set reason', {exact: true}).fill('Changed after generated output');
  await expect(page.getByLabel('Approve drawing set impact', {exact: true})).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Apply reviewed drawing set', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Download revised drawing set ZIP', exact: true})).not.toBeVisible();
});

test('saved multi-file insertion mappings resume with reordered renamed PDFs and fresh approval',async({page})=>{
  const base=await Promise.all([drawing('A.pdf','A'),drawing('B.pdf','B')]),revision=await Promise.all([drawing('A.pdf','A',true),drawing('B.pdf','B',true)]);
  await openSet(page,base,revision);await prepare(page);
  await page.getByLabel('Drawing set operation',{exact:true}).selectOption('insert-before');
  await page.getByLabel('Revision sheet for drawing 1 page 1',{exact:true}).selectOption('0');
  const plan=JSON.parse((await download(page,'Save drawing set plan')).toString());
  expect(plan.jobs).toHaveLength(2);expect(plan.jobs[0].pairs).toEqual([{basePage:2,revisionPage:2}]);
  expect(JSON.stringify(plan)).not.toMatch(/approved|bytes|A\.pdf|B\.pdf/);
  await page.getByRole('button',{name:'Close drawing set',exact:true}).click();
  await page.getByRole('button',{name:'Revise drawing set',exact:true}).click();
  await files(page,'Current drawing files',[{...base[1],name:'renamed-b.pdf'},{...base[0],name:'renamed-a.pdf'}]);
  await files(page,'Revision drawing files',[{...revision[0],name:'new-a.pdf'},{...revision[1],name:'new-b.pdf'}]);
  await page.getByLabel('Drawing set operation',{exact:true}).selectOption('replace');
  await page.getByLabel('Drawing set reason',{exact:true}).fill('Temporary reason');await prepare(page);
  await importSetPlan(page,{...plan,approved:true});
  await expect(page.getByLabel('Drawing set status',{exact:true})).toContainText('plan imported');
  await expect(page.getByLabel('Drawing set operation',{exact:true})).toHaveValue('insert-before');
  await expect(page.getByLabel('Revision file for current drawing 1',{exact:true})).toHaveValue('revision-2');
  await expect(page.getByLabel('Revision sheet for drawing 2 page 1',{exact:true})).toHaveValue('0');
  await expect(page.getByLabel('Approve drawing set impact',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Apply reviewed drawing set',exact:true})).toBeDisabled();
  await apply(page);
  const entries=unzipSync(await download(page,'Download revised drawing set ZIP')),manifest=JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.results.map((job:any)=>[job.base.sha256,job.revision.sha256,job.outputPageCount,job.status])).toEqual([[hash(base[1].bytes),hash(revision[1].bytes),4,'succeeded'],[hash(base[0].bytes),hash(revision[0].bytes),3,'succeeded']]);
});

test('malformed, wrong-source and ambiguous set plans preserve existing mappings and revoke approval',async({page})=>{
  const base=await Promise.all([drawing('A.pdf','A'),drawing('B.pdf','B')]),revision=await Promise.all([drawing('A.pdf','A',true),drawing('B.pdf','B',true)]);
  await openSet(page,base,revision);await prepare(page);
  const plan=JSON.parse((await download(page,'Save drawing set plan')).toString());
  const wrong=structuredClone(plan);wrong.jobs[1].revision.sha256='f'.repeat(64);
  for(const invalid of [{},wrong,{...plan,jobs:[plan.jobs[0],plan.jobs[0]]}]){
    await page.getByLabel('Approve drawing set impact',{exact:true}).check();await importSetPlan(page,invalid);
    await expect(page.getByLabel('Drawing set status',{exact:true})).toContainText('import failed');
    await expect(page.getByLabel('Approve drawing set impact',{exact:true})).not.toBeChecked();
    expect(JSON.parse((await download(page,'Save drawing set plan')).toString()).jobs).toEqual(plan.jobs.map((job:any)=>({...job,createdAt:expect.any(String)})));
  }
  // Selected drawings absent from a valid saved plan are explicitly excluded.
  await importSetPlan(page,{...plan,jobs:[plan.jobs[0]]});
  await expect(page.getByLabel('Drawing set status',{exact:true})).toContainText('plan imported');
  await expect(page.getByLabel('Revision file for current drawing 2',{exact:true})).toHaveValue('');
  await expect(page.locator('[data-exclusions]')).toContainText('current drawings: 2');
});

test('pending set-plan import cannot approve or overwrite a later reviewer edit',async({page})=>{
  const base=await drawing('A.pdf','A'),revision=await drawing('A.pdf','A',true);
  await openSet(page,[base],[revision]);await prepare(page);
  const plan=JSON.parse((await download(page,'Save drawing set plan')).toString());plan.jobs[0].reason='Stale imported reason';
  await page.evaluate(text=>{
    const original=File.prototype.text;
    (window as any).__setPlanRead={started:false};
    File.prototype.text=function(this:File){if(this.name!=='deferred-set.json')return original.call(this);return new Promise<string>(resolve=>{(window as any).__setPlanRead={started:true,release:()=>{File.prototype.text=original;resolve(text);}};});};
  },JSON.stringify(plan));
  await page.getByLabel('Approve drawing set impact',{exact:true}).check();await importSetPlan(page,plan,'deferred-set.json');
  await page.waitForFunction(()=>(window as any).__setPlanRead?.started);
  await page.getByLabel('Approve drawing set impact',{exact:true}).click();
  await expect(page.getByLabel('Approve drawing set impact',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Apply reviewed drawing set',exact:true})).toBeDisabled();
  await page.getByLabel('Drawing set reason',{exact:true}).fill('New reviewer edit');
  await page.evaluate(async()=>{(window as any).__setPlanRead.release();await new Promise(resolve=>setTimeout(resolve,0));});
  await expect(page.getByLabel('Drawing set reason',{exact:true})).toHaveValue('New reviewer edit');
  await expect(page.getByLabel('Drawing set status',{exact:true})).not.toContainText('plan imported');
  await expect(page.getByLabel('Approve drawing set impact',{exact:true})).not.toBeChecked();
  await apply(page);
});

