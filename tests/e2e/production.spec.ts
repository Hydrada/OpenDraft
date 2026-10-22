import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
// @ts-ignore Node fixture shared with unit tests.
import { drawingFixture } from '../fixture.mjs';
// @ts-ignore Authorized fixture shared with the alignment workflow tests.
import { alignmentDrawing } from '../alignment-fixture.mjs';

const origin = 'http://127.0.0.1:4178';
let server: ChildProcess | undefined;
test.beforeAll(async () => {
  server = spawn(process.execPath, ['scripts/serve-production.mjs'], { env: {...process.env, PORT:'4178'}, stdio:['ignore','pipe','pipe'], windowsHide:true });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { server?.kill(); reject(new Error(`Built server did not become ready: ${output}`)); }, 10_000);
    server!.once('error', error => { clearTimeout(timeout); reject(error); });
    server!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Built server exited (${code}): ${output}`)); });
    server!.stderr!.on('data', chunk => { output += chunk; });
    server!.stdout!.on('data', chunk => {
      output += chunk;
      if (output.includes(`http://127.0.0.1:4178`)) { clearTimeout(timeout); resolve(); }
    });
  });
});
test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
});

test('built alignment worker estimates locally under strict CSP without dynamic code permissions', async ({page}) => {
  const violations: string[] = [], failures: string[] = [], requests: string[] = [];
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    ((window as unknown as {policyViolations: string[]}).policyViolations ??= []).push(`${event.violatedDirective}: ${event.blockedURI}`);
  }));
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const response = await page.goto(origin);
  // WebAssembly compilation is allowed ('wasm-unsafe-eval'); JavaScript eval ('unsafe-eval') never is.
  expect(response!.headers()['content-security-policy']).not.toMatch(/(^|[\s;])'unsafe-eval'/);
  expect(response!.headers()['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval';");
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles({name: 'alignment.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await alignmentDrawing())});
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(1);
  await page.getByRole('button', {name: 'Compare drawing revisions', exact: true}).click();
  await page.getByRole('button', {name: 'Compare pages', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('Comparison ready');
  await page.getByRole('button', {name: 'Estimate alignment', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('ready for review', {timeout: 15000});
  await page.getByRole('button', {name: 'Apply alignment to comparison', exact: true}).click();
  await expect(page.getByLabel('Comparison status', {exact: true})).toContainText('Reviewed alignment applied');
  violations.push(...await page.evaluate(() => (window as unknown as {policyViolations?: string[]}).policyViolations ?? []));
  expect(violations).toEqual([]); expect(failures).toEqual([]);
  expect(requests.every(url => url.startsWith(`${origin}/`) || url.startsWith('blob:'))).toBe(true);
});

test('built app opens and searches a PDF with a local worker and no document uploads', async ({page, context}) => {
  const requests: Array<{url:string;method:string}> = [];
  context.on('request', request => requests.push({url:request.url(),method:request.method()}));
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const response = await page.goto(origin);
  expect(response!.headers()['content-security-policy']).toContain("connect-src 'self'");
  expect(response!.headers()['content-security-policy']).not.toContain('ws:');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'production.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  const canvas = page.getByTestId('pdf-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((el:HTMLCanvasElement) => {
    const data = el.getContext('2d')!.getImageData(0,0,el.width,el.height).data;
    let dark = 0; for (let n=0;n<data.length;n+=4) if (data[n+3] && data[n]<100 && data[n+1]<100 && data[n+2]<100) dark++;
    return dark;
  })).toBeGreaterThan(100);
  await page.getByLabel('Search document',{exact:true}).fill('Valve schedule');
  await page.getByRole('button',{name:'Find next',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await expect(page.getByText('Match on page 2',{exact:true})).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(requests.some(request => request.url.includes('pdf.worker') && request.url.startsWith(origin + '/assets/'))).toBe(true);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(origin);
    expect(['GET','HEAD']).toContain(request.method);
  }
});

test('static host returns safe headers, HEAD, missing asset and traversal errors', async ({request}) => {
  const response = await request.get(origin);
  expect(response.status()).toBe(200);
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['content-type']).toContain('text/html');
  const html = await response.text();
  const asset = html.match(/src="([^"]+\.js)"/)![1];
  const head = await request.head(origin + asset);
  expect(head.status()).toBe(200);
  expect(head.headers()['content-type']).toContain('text/javascript');
  expect(Number(head.headers()['content-length'])).toBeGreaterThan(0);
  expect((await head.body()).byteLength).toBe(0);
  expect((await request.get(origin + '/assets/missing.js')).status()).toBe(404);
  expect((await request.post(origin + '/', {data:'must-not-be-accepted'})).status()).toBe(405);
  expect((await request.get(origin + '/%2e%2e%2fpackage.json')).status()).toBe(403);
  expect((await request.get(origin + '/%ZZ')).status()).toBe(400);
});

test('built batch comparison exports locally with strict CSP and no external requests', async ({page}) => {
  const failures: string[] = [], requests: string[] = [];
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    ((window as unknown as {policyViolations: string[]}).policyViolations ??= []).push(`${event.violatedDirective}: ${event.blockedURI}`);
  }));
  page.on('pageerror', error => failures.push(error.message)); page.on('request', request => requests.push(request.url()));
  const response = await page.goto(origin);
  // WebAssembly compilation is allowed ('wasm-unsafe-eval'); JavaScript eval ('unsafe-eval') never is.
  expect(response!.headers()['content-security-policy']).not.toMatch(/(^|[\s;])'unsafe-eval'/);
  expect(response!.headers()['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval';");
  await page.getByLabel('Open PDF files', {exact: true}).setInputFiles({name: 'batch.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await drawingFixture())});
  await expect(page.locator('#tabs button[aria-pressed]')).toHaveCount(1);
  await page.getByRole('button', {name: 'Batch revision review', exact: true}).click();
  await page.getByLabel('Batch pairing strategy', {exact: true}).selectOption('order');
  await page.getByRole('button', {name: 'Prepare sheet pairs', exact: true}).click();
  await expect(page.getByLabel('Sheet pairing review', {exact: true})).toBeVisible();
  await page.getByLabel('Approve batch sheet pairs', {exact: true}).check();
  await page.getByRole('button', {name: 'Compare reviewed batch', exact: true}).click();
  await expect(page.getByLabel('Batch status', {exact: true})).toContainText('2 compared, 0 failed');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Export batch ZIP', exact: true}).click()]);
  expect(await download.failure()).toBeNull(); expect(download.suggestedFilename()).toBe('opendraft-batch-comparison.zip');
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as {policyViolations?: string[]}).policyViolations ?? [])).toEqual([]);
  expect(requests.every(url => url.startsWith(`${origin}/`) || url.startsWith('blob:'))).toBe(true);
});

test('built app renders JPEG 2000 images and non-embedded standard fonts under the strict CSP', async ({ page }) => {
  // Regression for REA finding R1 (docs/rea/FINDINGS.md): PDF.js runtime data was not bundled.
  const { PDFDocument, PDFName, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import('pdf-lib');
  const { readFile } = await import('node:fs/promises');
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([400, 300]);
  const jp2 = await readFile('tests/fixtures/red-blue-64.jp2');
  const image = pdf.context.register(pdf.context.stream(jp2, { Type: 'XObject', Subtype: 'Image', Width: 64, Height: 64, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'JPXDecode', Length: jp2.length }));
  sheet.node.setXObject(PDFName.of('Jpx'), image);
  sheet.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 200, 100, 50), drawObject('Jpx'), popGraphicsState());
  sheet.drawText('COURIER TITLE BLOCK', { x: 20, y: 270, size: 14, font: await pdf.embedFont(StandardFonts.Courier) });
  const warnings: string[] = [], resources: number[] = [];
  page.on('console', message => { if (/standardFontDataUrl|cMapUrl|wasmUrl|JpxError|Unable to decode image/i.test(message.text())) warnings.push(message.text()); });
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/pdfjs/')) resources.push(response.status()); });
  await page.goto(origin);
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'jpx.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  // Image occupies x 100..300, y 50..250 in PDF units: left half red, right half blue.
  const colours = await page.getByTestId('pdf-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!, sx = canvas.width / 400, sy = canvas.height / 300;
    const at = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * sx), Math.round((300 - y) * sy), 1, 1).data.slice(0, 3));
    return { left: at(150, 150), right: at(250, 150) };
  });
  expect(colours.left[0]).toBeGreaterThan(150); expect(colours.left[2]).toBeLessThan(90);
  expect(colours.right[2]).toBeGreaterThan(150); expect(colours.right[0]).toBeLessThan(90);
  await expect(page.locator('#text')).toContainText('COURIER TITLE BLOCK');
  expect(warnings).toEqual([]);
  expect(resources.every(status => status === 200)).toBe(true);
});

test('OCR makes a scanned sheet searchable offline under the production CSP', async ({ page }) => {
  test.setTimeout(120_000);
  const { PDFDocument } = await import('pdf-lib');
  const { readFile } = await import('node:fs/promises');
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([850, 550]);
  sheet.drawImage(await pdf.embedPng(await readFile('tests/fixtures/scanned-plan.png')), { x: 0, y: 0, width: 850, height: 550 });
  const external: string[] = [], violations: string[] = [];
  page.on('request', request => { if (!request.url().startsWith(origin) && !/^(blob|data):/.test(request.url())) external.push(request.url()); });
  page.on('console', message => { if (/Content Security Policy|CSP/i.test(message.text())) violations.push(message.text()); });
  await page.goto(origin);
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  await page.getByLabel('Search document', { exact: true }).fill('VALVE');
  await page.getByRole('button', { name: 'Find next', exact: true }).click();
  await expect(page.locator('#search-status')).toContainText(/No match|not found|0 match/i);
  await page.getByRole('button', { name: 'Recognize text on current page', exact: true }).click();
  await expect(page.getByRole('status', { name: 'OCR status' })).toContainText('opened a searchable copy', { timeout: 100_000 });
  await expect(page.locator('#document-name')).toHaveText('scan (OCR).pdf');
  await page.getByLabel('Search document', { exact: true }).fill('VALVE');
  await page.getByRole('button', { name: 'Find next', exact: true }).click();
  await expect(page.locator('#search-status')).toHaveText('Match on page 1');
  await expect(page.locator('#text')).toContainText('PUMP STATION');
  await expect(page.locator('#text')).toContainText('M201');
  expect(external).toEqual([]);
  expect(violations).toEqual([]);
});

test('OCR recognizes accented Spanish text with the Spanish model', async ({ page }) => {
  test.setTimeout(120_000);
  const { PDFDocument } = await import('pdf-lib');
  const { readFile } = await import('node:fs/promises');
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([850, 550]);
  sheet.drawImage(await pdf.embedPng(await readFile('tests/fixtures/scanned-plan-es.png')), { x: 0, y: 0, width: 850, height: 550 });
  await page.goto(origin);
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'plano.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  await page.getByLabel('OCR language', { exact: true }).selectOption('spa');
  await page.getByRole('button', { name: 'Recognize text on current page', exact: true }).click();
  await expect(page.getByRole('status', { name: 'OCR status' })).toContainText('opened a searchable copy', { timeout: 100_000 });
  await expect(page.locator('#text')).toContainText('ESTACIÓN');
  await expect(page.locator('#text')).toContainText('VÁLVULAS');
});
