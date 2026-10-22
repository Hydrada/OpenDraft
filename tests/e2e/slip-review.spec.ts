import {test, expect, type Page} from '@playwright/test';
import {PDFDocument, rgb} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

async function drawing(revised = false, large = false) {
  const pdf = await PDFDocument.create({updateMetadata: false});
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage(large ? [500, 400] : [400, 300]);
    page.drawText(`${revised ? 'REVISED' : 'ORIGINAL'} SHEET ${i + 1}`, {x: 30, y: 230, size: 20});
    page.drawRectangle({x: revised ? 250 : 50, y: 100, width: 40, height: 40, color: rgb(0, 0, 0)});
  }
  return Buffer.from(await pdf.save());
}
async function open(page: Page, base: Buffer, revision: Buffer) {
  await page.goto('/'); await expect(page.getByLabel('Open PDF files', {exact: true})).toBeEnabled();
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles([{name: 'base.pdf', mimeType: 'application/pdf', buffer: base}, {name: 'revision.pdf', mimeType: 'application/pdf', buffer: revision}]);
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(2);
  await page.getByRole('button', {name: 'View base.pdf', exact: true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 1');
}
async function prepare(page: Page) {
  await page.getByRole('button', {name: 'Replace revised sheets', exact: true}).click();
  await page.getByLabel('Slip pairing strategy', {exact: true}).selectOption('order');
  await page.getByLabel('Slip revision reason', {exact: true}).fill('Issued revision R1');
  await page.getByRole('button', {name: 'Prepare replacement review', exact: true}).click();
  await expect(page.getByLabel('Slip replacement review', {exact: true})).toBeVisible();
  await page.getByLabel('Replace current page 2 with', {exact: true}).selectOption('0');
}
async function apply(page: Page) {
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
  await page.getByRole('button', {name: 'Apply reviewed replacements', exact: true}).click();
}
async function downloaded(page: Page, name: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click()]);
  return readFile((await download.path())!);
}
test('replacement retains authored markup, clears reviewed takeoff, journals hashes, undoes/redoes and recovers editable replacement', async ({page}) => {
  const base = await drawing(), revision = await drawing(true); await open(page, base, revision);
  await page.getByLabel('Markup tool', {exact: true}).selectOption('rectangle');
  await page.getByLabel('Markup contents', {exact: true}).fill('Retain review note');
  await page.getByLabel('Markup y1', {exact: true}).fill('100');
  await page.getByLabel('Markup y2', {exact: true}).fill('150');
  await page.getByRole('button', {name: 'Add markup', exact: true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await page.getByLabel('Known calibration distance', {exact: true}).fill('10');
  await page.getByLabel('Review calibration reference', {exact: true}).check();
  await page.getByRole('button', {name: 'Save reviewed calibration', exact: true}).click();
  await page.getByLabel('Measurement label', {exact: true}).fill('Superseded quantity');
  await page.getByLabel('Measurement points', {exact: true}).fill('0,0;144,0');
  await page.getByRole('button', {name: 'Add measurement', exact: true}).click();
  await expect(page.getByLabel('Measurement records', {exact: true})).toContainText('Superseded quantity');
  const before = await downloaded(page, 'Save PDF');
  await prepare(page); await expect(page.getByLabel('Slip replacement review', {exact: true})).toContainText('1 measurements and 1 scale');
  await apply(page); await expect(page.getByLabel('Slip status', {exact: true})).toContainText('applied');
  const journal = JSON.parse((await downloaded(page, 'Export revision journal JSON')).toString());
  expect(journal.entries).toHaveLength(1);
  expect(journal.entries[0]).toMatchObject({reason: 'Issued revision R1', baseSha256: createHash('sha256').update(before).digest('hex'), revisionSha256: createHash('sha256').update(revision).digest('hex'), replacements: [{targetPage: 1, revisionPage: 1}], markupPolicy: 'retain', clearedMeasurements: 1, clearedScales: 1});
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 1');
  await expect(page.locator('.markup-list')).toContainText('Retain review note');
  await expect(page.getByLabel('Measurement records', {exact: true})).not.toContainText('Superseded quantity');
  await page.getByRole('button', {name: 'Undo edit', exact: true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 1');
  expect(await downloaded(page, 'Save PDF')).toEqual(before);
  await expect(page.getByLabel('Measurement records', {exact: true})).toContainText('Superseded quantity');
  await page.getByRole('button', {name: 'Redo edit', exact: true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 1');
  await page.getByLabel('Retain PDFs on this browser for recovery', {exact: true}).check();
  await expect(page.locator('#recovery-status')).toContainText('saved locally');
  page.on('dialog', dialog => dialog.accept()); await page.reload();
  await page.getByRole('button', {name: 'Restore retained session', exact: true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 1');
  await page.getByRole('button', {name: 'Replace revised sheets', exact: true}).click();
  await expect(page.getByLabel('Revision journal', {exact: true})).toContainText('Issued revision R1');
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  await page.getByRole('button', {name: 'Rotate page clockwise', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Rotate page clockwise', exact: true})).toBeEnabled();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 1');
});
test('geometry mismatch and locked-markup removal reject atomically; changed settings revoke review', async ({page}) => {
  await open(page, await drawing(), await drawing(true, true));
  await page.getByLabel('Markup tool', {exact: true}).selectOption('rectangle');
  await page.getByLabel('Markup contents', {exact: true}).fill('Protected note');
  await page.getByLabel('Markup y1', {exact: true}).fill('100');
  await page.getByLabel('Markup y2', {exact: true}).fill('150');
  await page.getByRole('button', {name: 'Add markup', exact: true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await page.locator('.markup-list button').click(); await page.getByLabel('Markup locked', {exact: true}).check();
  await page.getByRole('button', {name: 'Update selected markup', exact: true}).click();
  const before = await downloaded(page, 'Save PDF');
  await prepare(page); await apply(page);
  await expect(page.getByLabel('Slip error', {exact: true})).toContainText('geometry differs');
  await page.getByLabel('Slip markup policy', {exact: true}).selectOption('remove'); await apply(page);
  await expect(page.getByLabel('Slip error', {exact: true})).toContainText('Unlock');
  await page.getByLabel('Approve sheet replacement impact', {exact: true}).check();
  await page.getByLabel('Slip revision reason', {exact: true}).fill('Changed after approval');
  await expect(page.getByLabel('Approve sheet replacement impact', {exact: true})).not.toBeChecked();
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  expect(await downloaded(page, 'Save PDF')).toEqual(before);
});

test('damaged retained donor page bounds reject before restoring a replacement workspace', async ({page}) => {
  await open(page, await drawing(), await drawing(true)); await prepare(page); await apply(page);
  await expect(page.getByLabel('Slip status', {exact: true})).toContainText('applied');
  await page.getByRole('button', {name: 'Close replacement review', exact: true}).click();
  await page.getByLabel('Retain PDFs on this browser for recovery', {exact: true}).check();
  await expect(page.locator('#recovery-status')).toContainText('saved locally');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('opendraft-recovery', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('workspace', 'readwrite'), store = tx.objectStore('workspace'), get = store.get('latest');
      get.onsuccess = () => { const snapshot = get.result; snapshot.documents[0].workspace.pages[0].replacement.pageIndex = 999; store.put(snapshot, 'latest'); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
  page.on('dialog', dialog => dialog.accept()); await page.reload();
  await page.getByRole('button', {name: 'Restore retained session', exact: true}).click();
  await expect(page.locator('#recovery-status')).toContainText('Page index is outside');
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(0);
});


test('insert revision before old sheet stamps superseded, retains old markup, journals, undoes and recovers', async ({page}) => {
  await open(page, await drawing(), await drawing(true, true));
  await page.getByLabel('Markup tool', {exact:true}).selectOption('rectangle');
  await page.getByLabel('Markup contents', {exact:true}).fill('Old sheet note');
  await page.getByLabel('Markup y1', {exact:true}).fill('100');
  await page.getByLabel('Markup y2', {exact:true}).fill('150');
  await page.getByRole('button', {name:'Add markup',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await page.getByLabel('Known calibration distance',{exact:true}).fill('10');
  await page.getByLabel('Review calibration reference',{exact:true}).check();
  await page.getByRole('button',{name:'Save reviewed calibration',exact:true}).click();
  await page.getByLabel('Measurement label',{exact:true}).fill('Old takeoff');
  await page.getByLabel('Measurement points',{exact:true}).fill('0,0;144,0');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  await expect(page.getByLabel('Measurement records',{exact:true})).toContainText('Old takeoff');
  const before = await downloaded(page,'Save PDF');
  await page.getByRole('button',{name:'Replace revised sheets',exact:true}).click();
  await page.getByLabel('Slip operation',{exact:true}).selectOption('insert-before');
  await expect(page.getByLabel('Slip markup policy',{exact:true})).toBeDisabled();
  await page.getByLabel('Slip pairing strategy',{exact:true}).selectOption('order');
  await page.getByLabel('Slip revision reason',{exact:true}).fill('Insert issued R2');
  await page.getByRole('button',{name:'Prepare replacement review',exact:true}).click();
  await expect(page.getByLabel('Slip replacement review',{exact:true})).toBeVisible();
  await page.getByLabel('Replace current page 2 with',{exact:true}).selectOption('0');
  await apply(page);
  await expect(page.getByLabel('Slip status',{exact:true})).toContainText('inserted');
  const journal = JSON.parse((await downloaded(page,'Export revision journal JSON')).toString());
  expect(journal.entries[0]).toMatchObject({operation:'insert-before',reason:'Insert issued R2',markupPolicy:'retain',clearedMeasurements:1,clearedScales:1});
  await page.getByRole('button',{name:'Close replacement review',exact:true}).click();
  await expect(page.locator('#text')).toContainText('REVISED SHEET 1');
  await expect(page.getByLabel('Measurement records',{exact:true})).not.toContainText('Old takeoff');
  const bytes = await downloaded(page,'Save PDF'), pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(3);
  await expect(page.locator('.markup-list')).toContainText('Page 2 · rectangle · Old sheet note');
  await expect(page.locator('.markup-list')).toContainText('Page 2 · stamp (Draft) · SUPERSEDED');
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await expect(page.locator('#text')).toContainText('ORIGINAL SHEET 1');
  await expect(page.locator('.markup-list')).toContainText('Old sheet note');
  await expect(page.locator('.markup-list')).toContainText('SUPERSEDED');
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();
  expect(await downloaded(page,'Save PDF')).toEqual(before);
  await page.getByRole('button',{name:'Go to page 1',exact:true}).click();
  await expect(page.getByLabel('Measurement records',{exact:true})).toContainText('Old takeoff');
  await page.getByRole('button',{name:'Redo edit',exact:true}).click();
  await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();
  await expect(page.locator('#recovery-status')).toContainText('saved locally');
  page.on('dialog',dialog=>dialog.accept()); await page.reload();
  await page.getByRole('button',{name:'Restore retained session',exact:true}).click();
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(2);
  const recovered = await PDFDocument.load(await downloaded(page,'Save PDF'));
  expect(recovered.getPageCount()).toBe(3);
  await page.getByRole('button',{name:'Replace revised sheets',exact:true}).click();
  await expect(page.getByLabel('Revision journal',{exact:true})).toContainText('insert-before');
});
