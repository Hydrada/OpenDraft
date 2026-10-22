import { test, expect, type Page, type Browser } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-ignore Node fixture shared with unit tests.
import { drawingFixture } from '../fixture.mjs';

// Built app served same-origin by the self-hosted collaboration server (requires npm run build).
const origin = 'http://127.0.0.1:4180', password = 'correct horse battery';
let server: ChildProcess | undefined, dataDir = '', sitePdf: Buffer;
test.beforeAll(async () => {
  sitePdf = Buffer.from(await drawingFixture());
  dataDir = mkdtempSync(path.join(tmpdir(), 'opendraft-collab-e2e-'));
  // OPENDRAFT_COLLAB_ROOT points at an extracted self-host release to test the real deployment.
  const cwd = process.env.OPENDRAFT_COLLAB_ROOT ?? process.cwd();
  const env = { ...process.env, OPENDRAFT_DATA: dataDir, OPENDRAFT_PASSWORD: password, PORT: '4180' };
  for (const user of ['alice', 'bob', 'val']) execFileSync(process.execPath, ['server/collab-server.mjs', 'user-add', user], { env, cwd, windowsHide: true });
  execFileSync(process.execPath, ['server/collab-server.mjs', 'user-add', 'ada', '--admin'], { env, cwd, windowsHide: true });
  server = spawn(process.execPath, ['server/collab-server.mjs', 'serve'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Collaboration server not ready: ${output}`)), 10_000);
    server!.stderr!.on('data', chunk => { output += chunk; });
    server!.stdout!.on('data', chunk => { output += chunk; if (output.includes(origin)) { clearTimeout(timeout); resolve(); } });
  });
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  rmSync(dataDir, { recursive: true, force: true });
});

async function open(browser: Browser, user: string) {
  const context = await browser.newContext({ viewport: { width: 1800, height: 1200 } });
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'site.pdf', mimeType: 'application/pdf', buffer: sitePdf });
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await page.getByLabel('Collaboration user name', { exact: true }).fill(user);
  await page.getByLabel('Collaboration password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to collaboration', exact: true }).click();
  await expect(status(page)).toContainText(`Signed in as ${user}`);
  return { page, context };
}
const status = (page: Page) => page.getByRole('status', { name: 'Collaboration status', exact: true });
const markupCount = (page: Page) => page.evaluate(() => document.querySelectorAll('.markup-list button').length);

async function addRectangle(page: Page, _x: number, _y: number) {
  await page.getByLabel('Markup tool', { exact: true }).selectOption('rectangle');
  await page.getByRole('button', { name: 'Add markup', exact: true }).click();
}

test('two browsers share markups live with roles, presence and viewer read-only enforcement', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  await alice.page.getByLabel('New collaboration project name', { exact: true }).fill('Site review');
  await alice.page.getByRole('button', { name: 'Create project for this PDF', exact: true }).click();
  await expect(status(alice.page)).toContainText('Site review · owner');
  for (const [user, role] of [['bob', 'editor'], ['val', 'viewer']]) {
    await alice.page.getByLabel('Member user name', { exact: true }).fill(user);
    await alice.page.getByLabel('Member role', { exact: true }).selectOption(role);
    await alice.page.getByRole('button', { name: 'Set member role', exact: true }).click();
    await expect(status(alice.page)).toContainText(`Membership updated for ${user}`);
  }
  const bob = await open(browser, 'bob');
  await bob.page.getByLabel('Collaboration project', { exact: true }).selectOption({ label: 'Site review (editor)' });
  await bob.page.getByRole('button', { name: 'Join collaboration project', exact: true }).click();
  await expect(status(bob.page)).toContainText('Synchronized');

  const before = await markupCount(bob.page);
  await addRectangle(alice.page, 100, 100);
  await expect.poll(() => markupCount(bob.page), { timeout: 10_000 }).toBe(before + 1);
  await addRectangle(bob.page, 300, 200);
  await expect.poll(() => markupCount(alice.page), { timeout: 10_000 }).toBe(before + 2);
  await expect(alice.page.getByLabel('Collaborators present', { exact: true })).toContainText('bob on page 1', { timeout: 15_000 });

  // Page organization is blocked while joined, so page indexes cannot diverge.
  await bob.page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await expect(bob.page.getByRole('alert')).toContainText('Leave the collaboration project before reorganizing pages');

  const val = await open(browser, 'val');
  await val.page.getByLabel('Collaboration project', { exact: true }).selectOption({ label: 'Site review (viewer)' });
  await val.page.getByRole('button', { name: 'Join collaboration project', exact: true }).click();
  await expect.poll(() => markupCount(val.page), { timeout: 10_000 }).toBe(before + 2);
  await addRectangle(val.page, 400, 300);
  await expect(val.page.getByRole('alert')).toContainText('Viewer role');
  await expect.poll(() => markupCount(alice.page)).toBe(before + 2);

  // A different PDF cannot join this project.
  const other = await browser.newContext(); const otherPage = await other.newPage();
  await otherPage.goto(origin + '/');
  await otherPage.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await (await import('pdf-lib')).PDFDocument.create().then(async doc => { doc.addPage(); return doc.save(); })) });
  await otherPage.getByLabel('Collaboration user name', { exact: true }).fill('bob');
  await otherPage.getByLabel('Collaboration password', { exact: true }).fill(password);
  await otherPage.getByRole('button', { name: 'Sign in to collaboration', exact: true }).click();
  await expect(status(otherPage)).toContainText('Signed in as bob');
  await otherPage.getByLabel('Collaboration project', { exact: true }).selectOption({ label: 'Site review (editor)' });
  await otherPage.getByRole('button', { name: 'Join collaboration project', exact: true }).click();
  await expect(status(otherPage)).toContainText('bound to a different PDF');
  for (const context of [alice.context, bob.context, val.context, other]) await context.close();
});

test('offline edits queue on the device and sync after reconnect', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  await alice.page.getByLabel('Collaboration project', { exact: true }).selectOption({ label: 'Site review (owner)' });
  await alice.page.getByRole('button', { name: 'Join collaboration project', exact: true }).click();
  await expect(status(alice.page)).toContainText('Synchronized');
  const bob = await open(browser, 'bob');
  await bob.page.getByLabel('Collaboration project', { exact: true }).selectOption({ label: 'Site review (editor)' });
  await bob.page.getByRole('button', { name: 'Join collaboration project', exact: true }).click();
  await expect(status(bob.page)).toContainText('Synchronized');
  const before = await markupCount(alice.page);
  await bob.context.setOffline(true);
  await addRectangle(bob.page, 200, 400);
  await expect(status(bob.page)).toContainText(/Offline|Connection lost/, { timeout: 10_000 });
  await expect.poll(() => bob.page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('opendraft.collab.v1:bob:')))).toBe(true);
  expect(await markupCount(alice.page)).toBe(before);
  await bob.context.setOffline(false);
  await expect.poll(() => markupCount(alice.page), { timeout: 40_000 }).toBe(before + 1);
  await expect(status(bob.page)).toContainText('Synchronized', { timeout: 40_000 });
  await alice.context.close(); await bob.context.close();
});

test('an administrator publishes the team tool set and another user loads it into their preset library', async ({ browser }) => {
  const ada = await open(browser, 'ada');
  await ada.page.getByLabel('Markup tool', { exact: true }).selectOption('cloud');
  await ada.page.getByLabel('Preset name', { exact: true }).fill('Team RFI cloud');
  await ada.page.getByRole('button', { name: 'Save new markup preset', exact: true }).click();
  await ada.page.getByRole('button', { name: 'Publish my presets as the team tool set', exact: true }).click();
  await expect(status(ada.page)).toContainText('Team tool set published.');
  const bob = await open(browser, 'bob');
  const presets = bob.page.getByLabel('Saved markup presets', { exact: true });
  await expect(presets.locator('option', { hasText: 'Team RFI cloud' })).toHaveCount(0);
  await bob.page.getByRole('button', { name: 'Publish my presets as the team tool set', exact: true }).click();
  await expect(status(bob.page)).toContainText('Only administrators');
  await bob.page.getByRole('button', { name: 'Load team tool set', exact: true }).click();
  await expect(status(bob.page)).toContainText('Loaded 1 team preset(s) published by ada.');
  await expect(presets.locator('option', { hasText: 'Team RFI cloud · cloud' })).toHaveCount(1);
  await ada.context.close(); await bob.context.close();
});
