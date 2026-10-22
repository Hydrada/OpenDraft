import {test, expect, type Page} from '@playwright/test';
import {PDFDocument, PDFName, rgb} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

type SavedPlan = {schema: string; version: number; createdAt: string; base: {sha256: string; pageCount: number}; revision: {sha256: string; pageCount: number}; operation: 'replace' | 'insert-before'; markupPolicy: string; reason: string; pairs: {basePage: number; revisionPage: number}[]};
async function drawing(revised = false) {
  const pdf = await PDFDocument.create({updateMetadata: false});
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([400, 300]);
    page.drawText(`${revised ? 'REVISED' : 'ORIGINAL'} SHEET ${i + 1}`, {x: 30, y: 230, size: 20});
    page.drawRectangle({x: revised ? 240 : 40, y: 80 + i * 35, width: 40, height: 30, color: rgb(0, 0, 0)});
  }
  return Buffer.from(await pdf.save({updateFieldAppearances: false}));
}
async function open(page: Page, base: Buffer, revision: Buffer) {
  await page.goto('/');
  await expect(page.getByLabel('Open PDF files', {exact: true})).toBeEnabled();
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles([{name: 'base.pdf', mimeType: 'application/pdf', buffer: base}, {name: 'revision.pdf', mimeType: 'application/pdf', buffer: revision}]);
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(2);
  await page.getByRole('button', {name: 'View base.pdf', exact: true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 1');
}
async function downloaded(page: Page, name: string) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click()]);
  return readFile((await file.path())!);
}
async function dialog(page: Page) {
  await page.getByRole('button', {name: 'Replace revised sheets', exact: true}).click();
}
async function customPlan(page: Page, operation: 'replace' | 'insert-before' = 'replace') {
  await dialog(page);
  await page.getByLabel('Slip operation', {exact: true}).selectOption(operation);
  await page.getByLabel('Slip pairing strategy', {exact: true}).selectOption('order');
  await page.getByLabel('Slip revision reason', {exact: true}).fill('R7 reviewed custom mapping: sheet 1 uses revision 2');
  await page.getByRole('button', {name: 'Prepare replacement review', exact: true}).click();
  await expect(page.getByLabel('Slip replacement review', {exact: true})).toBeVisible();
  await page.getByLabel('Replace current page 2 with', {exact: true}).selectOption('0');
  await page.getByLabel('Replace current page 1 with', {exact: true}).selectOption('2');
  return JSON.parse((await downloaded(page, 'Save revision plan JSON')).toString()) as SavedPlan;
}
async function importPlan(page: Page, plan: SavedPlan | Buffer, name = 'reviewed-plan.json') {
  await page.getByLabel('Import revision plan JSON', {exact: true}).setInputFiles({name, mimeType: 'application/json', buffer: Buffer.isBuffer(plan) ? plan : Buffer.from(JSON.stringify(plan))});
}
async function expectFreshImport(page: Page, operation: 'replace' | 'insert-before') {
  await expect(page.getByLabel('Slip status', {exact: true})).toContainText('Saved revision plan loaded');
  await expect(page.getByLabel('Replace current page 1 with', {exact: true})).toHaveValue('2');
  await expect(page.getByLabel('Replace current page 2 with', {exact: true})).toHaveValue('0');
  await expect(page.getByLabel('Slip revision reason', {exact: true})).toHaveValue('R7 reviewed custom mapping: sheet 1 uses revision 2');
  await expect(page.getByLabel('Slip operation', {exact: true})).toHaveValue(operation);
  await expect(page.getByLabel('Approve sheet replacement impact', {exact: true})).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Apply reviewed replacements', exact: true})).toBeDisabled();
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('saved source-bound custom replacement plan restores mapping and requires fresh approval before real edits', async ({page}) => {
  const base = await drawing(), revision = await drawing(true);
  await open(page, base, revision);
  const plan = await customPlan(page);
  expect(plan).toMatchObject({schema: 'opendraft.revision-plan', version: 1, operation: 'replace', markupPolicy: 'retain', base: {sha256: hash(base), pageCount: 2}, revision: {sha256: hash(revision), pageCount: 2}, pairs: [{basePage: 1, revisionPage: 2}]});
  expect(plan.pairs).toHaveLength(1);
  expect(Number.isFinite(Date.parse(plan.createdAt))).toBe(true);
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  expect(await downloaded(page, 'Save PDF')).toEqual(base);
  await dialog(page); await importPlan(page, plan); await expectFreshImport(page, 'replace');
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  expect(await downloaded(page, 'Save PDF')).toEqual(base);
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
  await dialog(page); await importPlan(page, plan); await expectFreshImport(page, 'replace');
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
  await page.getByRole('button', {name: 'Apply reviewed replacements', exact: true}).click();
  await expect(page.getByLabel('Slip status', {exact: true})).toContainText('applied');
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 2');
  await page.getByRole('button', {name: 'Next page', exact: true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 2');
  expect((await PDFDocument.load(await downloaded(page, 'Save PDF'))).getPageCount()).toBe(2);
  await page.getByRole('button', {name: 'View revision.pdf', exact: true}).click();
  expect(await downloaded(page, 'Save PDF')).toEqual(revision);
});

test('wrong source, malformed, duplicate and oversized imports preserve current prepared mapping and revoke approval', async ({page}) => {
  const base = await drawing(), revision = await drawing(true);
  await open(page, base, revision);
  const plan = await customPlan(page);
  const wrongSource = structuredClone(plan); wrongSource.base.sha256 = '0'.repeat(64);
  const duplicate = structuredClone(plan); duplicate.pairs.push({...duplicate.pairs[0]});
  const attempts = [
    {name: 'wrong-source.json', bytes: Buffer.from(JSON.stringify(wrongSource))},
    {name: 'malformed.json', bytes: Buffer.from('{not valid JSON')},
    {name: 'duplicate.json', bytes: Buffer.from(JSON.stringify(duplicate))},
    {name: 'oversized.json', bytes: Buffer.alloc(256 * 1024 + 1, 32)},
  ];
  for (const attempt of attempts) {
    await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
    await expect(page.getByRole('button', {name: 'Apply reviewed replacements', exact: true})).toBeEnabled();
    await importPlan(page, attempt.bytes, attempt.name);
    await expect(page.getByLabel('Slip error', {exact: true})).toBeVisible();
    await expect(page.getByLabel('Approve sheet replacement impact', {exact: true})).not.toBeChecked();
    await expect(page.getByRole('button', {name: 'Apply reviewed replacements', exact: true})).toBeDisabled();
    await expect(page.getByLabel('Replace current page 1 with', {exact: true})).toHaveValue('2');
    await expect(page.getByLabel('Replace current page 2 with', {exact: true})).toHaveValue('0');
    await expect(page.getByLabel('Slip revision reason', {exact: true})).toHaveValue(plan.reason);
    // The existing plan must remain usable/exportable rather than being replaced
    // by an invalid import, including one whose sources do not match.
    const retained = JSON.parse((await downloaded(page, 'Save revision plan JSON')).toString()) as SavedPlan;
    expect(retained.pairs).toEqual(plan.pairs);
    expect(retained.base).toEqual(plan.base);
    expect(retained.revision).toEqual(plan.revision);
    expect(retained.reason).toBe(plan.reason);
  }
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  expect(await downloaded(page, 'Save PDF')).toEqual(base);
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
});

test('insert-before saved plan round trip retains old sheet and adds superseded stamp only after fresh approval', async ({page}) => {
  const base = await drawing(), revision = await drawing(true);
  await open(page, base, revision);
  const plan = await customPlan(page, 'insert-before');
  expect(plan.operation).toBe('insert-before'); expect(plan.markupPolicy).toBe('retain');
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  expect(await downloaded(page, 'Save PDF')).toEqual(base);
  await dialog(page);
  await page.getByLabel('Slip operation', {exact: true}).selectOption('replace');
  await importPlan(page, plan); await expectFreshImport(page, 'insert-before');
  await expect(page.getByLabel('Slip markup policy', {exact: true})).toBeDisabled();
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
  await page.getByRole('button', {name: 'Apply reviewed replacements', exact: true}).click();
  await expect(page.getByLabel('Slip status', {exact: true})).toContainText('inserted');
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 2');
  await expect(page.locator('.markup-list')).toContainText('Page 2 · stamp (Draft) · SUPERSEDED');
  const output = await PDFDocument.load(await downloaded(page, 'Save PDF'));
  expect(output.getPageCount()).toBe(3);
  const stamps = output.getPage(1).node.Annots()!.asArray().map(ref => output.context.lookup(ref));
  expect(stamps.some((annot: any) => annot.get(PDFName.of('Subtype'))?.toString() === '/Stamp' && annot.get(PDFName.of('Contents'))?.decodeText() === 'SUPERSEDED')).toBe(true);
  await page.getByRole('button', {name: 'Next page', exact: true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 1');
  await page.getByRole('button', {name: 'Next page', exact: true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 2');
});

test('a delayed plan read cannot grant approval or overwrite edits made while the import is pending', async ({page}) => {
  const base = await drawing(), revision = await drawing(true);
  await open(page, base, revision);
  const existing = await customPlan(page);
  const delayed = structuredClone(existing);
  delayed.reason = 'Stale reason from deferred file';
  delayed.pairs = [{basePage: 1, revisionPage: 1}];
  await page.evaluate(text => {
    const original = File.prototype.text;
    const state: {started: boolean; release?: () => void; restore: () => void} = {
      started: false,
      restore: () => { File.prototype.text = original; },
    };
    (window as any).__revisionFileRead = state;
    File.prototype.text = function(this: File) {
      if (this.name !== 'deferred-plan.json') return original.call(this);
      return new Promise<string>(resolve => {
        state.started = true;
        state.release = () => resolve(text);
      });
    };
  }, JSON.stringify(delayed));
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
  await importPlan(page, delayed, 'deferred-plan.json');
  await page.waitForFunction(() => (window as any).__revisionFileRead?.started === true);
  await expect(page.getByLabel('Slip status', {exact: true})).toContainText('Reading revision plan');
  await expect(page.getByLabel('Approve sheet replacement impact', {exact: true})).not.toBeChecked();
  // check() expects a checked postcondition; click() lets us assert that the
  // application's pending-import guard immediately refuses that transition.
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).click();
  await expect(page.getByLabel('Approve sheet replacement impact', {exact: true})).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Apply reviewed replacements', exact: true})).toBeDisabled();
  const latestReason = 'Reviewer changed the reason while file text was pending';
  await page.getByLabel('Slip revision reason', {exact: true}).fill(latestReason);
  await page.evaluate(async () => {
    const state = (window as any).__revisionFileRead;
    if (!state?.release) throw new Error('Expected a pending deferred file read.');
    state.release(); state.restore();
    // Let the import continuation observe its obsolete generation and finish.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  await expect(page.getByLabel('Slip revision reason', {exact: true})).toHaveValue(latestReason);
  await expect(page.getByLabel('Replace current page 1 with', {exact: true})).toHaveValue('2');
  await expect(page.getByLabel('Replace current page 2 with', {exact: true})).toHaveValue('0');
  await expect(page.getByLabel('Slip status', {exact: true})).not.toContainText('Saved revision plan loaded');
  await expect(page.getByLabel('Approve sheet replacement impact', {exact: true})).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Apply reviewed replacements', exact: true})).toBeDisabled();
  const retained = JSON.parse((await downloaded(page, 'Save revision plan JSON')).toString()) as SavedPlan;
  expect(retained.reason).toBe(latestReason);
  expect(retained.pairs).toEqual(existing.pairs);
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
  // Invoke the existing read-only Save action without closing the review, so
  // byte identity and retention of the still-prepared plan are both verified.
  const [unchanged] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => document.querySelector<HTMLButtonElement>('#save')!.click()),
  ]);
  expect(await readFile((await unchanged.path())!)).toEqual(base);
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
  await page.getByRole('button', {name: 'Apply reviewed replacements', exact: true}).click();
  await expect(page.getByLabel('Slip status', {exact: true})).toContainText('applied');
  const journal = JSON.parse((await downloaded(page, 'Export revision journal JSON')).toString());
  expect(journal.entries[0]).toMatchObject({reason: latestReason, replacements: [{targetPage: 1, revisionPage: 2}]});
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 2');
});
