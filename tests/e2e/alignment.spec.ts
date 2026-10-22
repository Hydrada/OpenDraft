import {test, expect, type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
// @ts-ignore Shared authorized Node fixture.
import {alignmentDrawing} from '../alignment-fixture.mjs';

async function open(page: Page, base: Uint8Array, revision: Uint8Array) {
  await page.goto('/');
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles([
    {name: 'base.pdf', mimeType: 'application/pdf', buffer: Buffer.from(base)},
    {name: 'revision.pdf', mimeType: 'application/pdf', buffer: Buffer.from(revision)},
  ]);
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(2);
  await page.getByRole('button', {name: 'Compare drawing revisions', exact: true}).click();
  await page.getByLabel('Comparison base document', {exact: true}).selectOption({label: 'base.pdf'});
  await page.getByLabel('Comparison revision document', {exact: true}).selectOption({label: 'revision.pdf'});
}
async function compare(page: Page) {
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('Comparison ready');
  await expect(page.getByRole('button', {name: 'Estimate alignment', exact: true})).toBeEnabled();
}
async function data(page: Page, name = 'Export comparison evidence JSON') {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click()]);
  return readFile((await download.path())!);
}
async function estimate(page: Page) {
  await page.getByRole('button', {name: 'Estimate alignment', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('ready for review', {timeout: 15000});
  await expect(page.getByLabel('Alignment review', {exact: true})).toBeVisible();
}

test('automatic rotation/scale/translation is a reviewable proposal bound to immutable snapshots', async ({page}) => {
  const base = await alignmentDrawing(), sourceScale = 1.06, angle = 7, dx = 16, dy = -17;
  const revision = await alignmentDrawing({scale: sourceScale, rotation: angle, dx, dy});
  await open(page, base, revision); await compare(page);
  const original = JSON.parse((await data(page)).toString());
  await estimate(page);
  expect(JSON.parse((await data(page)).toString())).toEqual(original);
  await page.getByRole('button', {name: 'Discard alignment estimate', exact: true}).click();
  expect(JSON.parse((await data(page)).toString())).toEqual(original);
  await estimate(page);
  await page.getByRole('button', {name: 'Apply alignment to comparison', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('Reviewed alignment applied');
  const accepted = JSON.parse((await data(page)).toString());
  expect(accepted.alignment.method).toBe('reviewed automatic similarity');
  expect(accepted.alignment.proposal.inliers).toBeGreaterThanOrEqual(8);
  expect(accepted.alignment.proposal.coverage).toBeGreaterThanOrEqual(0.08);
  expect(accepted.alignment.scale).toBeCloseTo(1 / sourceScale, 2);
  expect(accepted.alignment.rotationDegrees).toBeCloseTo(-angle, 0);
  const [a, b, c, d, e, f] = accepted.alignment.matrix;
  const theta = angle * Math.PI / 180;
  for (const [x, y] of [[80, 80], [500, 80], [80, 400], [500, 400], [300, 250]]) {
    const rx = sourceScale * (Math.cos(theta) * x - Math.sin(theta) * y) + dx;
    const ry = sourceScale * (Math.sin(theta) * x + Math.cos(theta) * y) + dy;
    expect(Math.hypot(a * rx + c * ry + e - x, b * rx + d * ry + f - y)).toBeLessThan(3);
  }
  expect(accepted.comparison.changedPixels).toBeLessThan(original.comparison.changedPixels * 0.75);
  expect(accepted.base.sha256).toBe(original.base.sha256); expect(accepted.revision.sha256).toBe(original.revision.sha256);
  expect(Number.isFinite(Date.parse(accepted.alignment.reviewedAt))).toBe(true);
  await page.getByLabel('Comparison threshold', {exact: true}).fill('24');
  await expect(page.getByLabel('Alignment review', {exact: true})).toBeHidden();
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
  await compare(page);
  expect(JSON.parse((await data(page)).toString()).alignment.method).toBe('explicit similarity');
  await page.getByRole('button', {name: 'Close comparison', exact: true}).click();
  expect(await data(page, 'Save PDF')).toEqual(Buffer.from(revision));
  await expect(page.getByRole('button', {name: 'Undo edit', exact: true})).toBeDisabled();
});

test('manual scale and clockwise rotation preserve the full transformed union and export its physical size', async ({page}) => {
  const source = await alignmentDrawing(); await open(page, source, source);
  await page.getByLabel('Revision alignment scale', {exact: true}).fill('2');
  await page.getByLabel('Revision alignment rotation', {exact: true}).fill('90');
  await page.getByLabel('Revision horizontal offset', {exact: true}).fill('1000');
  await compare(page);
  const evidence = JSON.parse((await data(page)).toString());
  expect(evidence.alignment).toMatchObject({method: 'explicit similarity', matrix: [0, 2, -2, 0, 1000, 0], scale: 2, rotationDegrees: 90});
  expect(evidence.comparison).toMatchObject({width: 1000, height: 1200, originX: 0, originY: 0});
  const exported = await PDFDocument.load(await data(page, 'Export comparison PDF'));
  expect(exported.getPage(0).getSize()).toEqual({width: 1000, height: 1200});
  await page.getByLabel('Revision alignment scale', {exact: true}).fill('11');
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison error', {exact: true})).toContainText('scale');
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
});

test('cancelling estimation, editing a proposal and blank drawings cannot publish or apply stale alignment', async ({page}) => {
  const source = await alignmentDrawing(); await open(page, source, source); await compare(page);
  await page.evaluate(() => {
    (document.querySelector('[data-action="estimate"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
  });
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('cancelled');
  await expect(page.getByLabel('Alignment review', {exact: true})).toBeHidden();
  await expect(page.getByRole('button', {name: 'Estimate alignment', exact: true})).toBeDisabled();
  await compare(page); await estimate(page);
  await page.getByLabel('Revision vertical offset', {exact: true}).fill('1');
  await expect(page.getByLabel('Alignment review', {exact: true})).toBeHidden();
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeHidden();
  await compare(page);
  expect(JSON.parse((await data(page)).toString()).alignment.method).toBe('explicit translation');
  await page.getByRole('button', {name: 'Close comparison', exact: true}).click();
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles({name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await alignmentDrawing({blank: true}))});
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(3);
  await page.getByRole('button', {name: 'Compare drawing revisions', exact: true}).click();
  for (const name of ['Comparison base document', 'Comparison revision document']) await page.getByLabel(name, {exact: true}).selectOption({label: 'blank.pdf'});
  await compare(page);
  await page.getByRole('button', {name: 'Estimate alignment', exact: true}).click();
  await expect(page.getByLabel('Comparison error', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Alignment review', {exact: true})).toBeHidden();
  await expect(page.getByLabel('Comparison result', {exact: true})).toBeVisible();
  expect(JSON.parse((await data(page)).toString()).alignment.method).toBe('explicit translation');
});
