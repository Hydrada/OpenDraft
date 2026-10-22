import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

test('sign a copy with a PKCS#12 certificate, reopen it and verify the signature', async ({ page }) => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600, 400]).drawText('ISSUED FOR CONSTRUCTION', { x: 40, y: 340, size: 18, font });
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'issue.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  const status = page.getByRole('status', { name: 'Signature status' });
  // No certificate chosen: explicit message, nothing downloaded.
  await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
  await expect(status).toHaveText('Choose your certificate file first.');
  await page.getByLabel('Signing certificate (.p12 or .pfx)', { exact: true }).setInputFiles('tests/fixtures/test-signer.p12');
  await page.getByLabel('Certificate password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
  await expect(status).toContainText('Wrong password');
  await page.getByLabel('Certificate password', { exact: true }).fill('opendraft-test');
  await page.getByLabel('Signature reason', { exact: true }).fill('Issued for construction');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
  const file = (await (await download).path())!;
  await expect(status).toContainText('signed by OpenDraft Test Signer');
  await expect(page.getByLabel('Certificate password', { exact: true })).toHaveValue('');
  // The open document has no signature; the downloaded copy has a valid one.
  await page.getByRole('button', { name: 'Check signatures in this PDF', exact: true }).click();
  await expect(status).toHaveText('This PDF has no digital signatures.');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'issue-signed.pdf', mimeType: 'application/pdf', buffer: await readFile(file) });
  await expect(page.locator('#document-name')).toHaveText('issue-signed.pdf');
  await page.getByRole('button', { name: 'Check signatures in this PDF', exact: true }).click();
  await expect(status).toHaveText('1 of 1 signature(s) valid.');
  await expect(page.getByRole('list', { name: 'Signatures in this PDF' })).toContainText('VALID · signed by OpenDraft Test Signer');
  await expect(page.getByRole('list', { name: 'Signatures in this PDF' })).toContainText('Issued for construction');
});

test('a certified document can be counter-signed; both signatures verify and chain to a trusted certificate', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  await page.goto('/');
  const openBytes = async (name: string, buffer: Buffer) => {
    await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await expect(page.locator('#document-name')).toHaveText(name);
  };
  const sign = async (reason: string, certify?: string) => {
    await page.getByLabel('Signing certificate (.p12 or .pfx)', { exact: true }).setInputFiles('tests/fixtures/test-signer.p12');
    await page.getByLabel('Certificate password', { exact: true }).fill('opendraft-test');
    await page.getByLabel('Signature reason', { exact: true }).fill(reason);
    await page.getByLabel('Certify document', { exact: true }).selectOption(certify ?? '');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
    return readFile((await (await download).path())!);
  };
  await openBytes('drawing.pdf', Buffer.from(await pdf.save()));
  await openBytes('certified.pdf', await sign('Certified for issue', '2'));
  await openBytes('countersigned.pdf', await sign('Checked'));
  await page.getByLabel('Trusted certificates for checking (.pem/.cer/.crt, optional)', { exact: true }).setInputFiles('tests/fixtures/test-signer-cert.pem');
  await page.getByRole('button', { name: 'Check signatures in this PDF', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Signature status' })).toHaveText('2 of 2 signature(s) valid.');
  const list = page.getByRole('list', { name: 'Signatures in this PDF' });
  await expect(list.locator('li').nth(0)).toContainText('VALID · TRUSTED');
  await expect(list.locator('li').nth(0)).toContainText('certifies the document (level 2)');
  await expect(list.locator('li').nth(1)).toContainText('Checked');
});

test('a signer revoked by their certificate authority is flagged when the revocation list is supplied', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'drawing.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
  await page.getByLabel('Signing certificate (.p12 or .pfx)', { exact: true }).setInputFiles('tests/fixtures/test-ca-signer-revoked.p12');
  await page.getByLabel('Certificate password', { exact: true }).fill('opendraft-test');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
  const signed = await readFile((await (await download).path())!);
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: signed });
  await expect(page.locator('#document-name')).toHaveText('signed.pdf');
  await page.getByLabel('Trusted certificates for checking (.pem/.cer/.crt, optional)', { exact: true }).setInputFiles('tests/fixtures/test-ca.pem');
  await page.getByLabel('Revocation lists for checking (.crl, optional)', { exact: true }).setInputFiles('tests/fixtures/test-ca.crl');
  await page.getByRole('button', { name: 'Check signatures in this PDF', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Signatures in this PDF' })).toContainText('VALID · TRUSTED · REVOKED');
});

test('long-term validation data is embedded and later used without supplying the revocation list again', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  await page.goto('/');
  const openBytes = async (name: string, buffer: Buffer) => {
    await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await expect(page.locator('#document-name')).toHaveText(name);
    await expect(page.locator('#status')).toContainText('Page 1 of 1');
  };
  await openBytes('drawing.pdf', Buffer.from(await pdf.save()));
  await page.getByLabel('Signing certificate (.p12 or .pfx)', { exact: true }).setInputFiles('tests/fixtures/test-ca-signer-good.p12');
  await page.getByLabel('Certificate password', { exact: true }).fill('opendraft-test');
  let download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
  await openBytes('signed.pdf', await readFile((await (await download).path())!));
  await page.getByLabel('Trusted certificates for checking (.pem/.cer/.crt, optional)', { exact: true }).setInputFiles('tests/fixtures/test-ca.pem');
  await page.getByLabel('Revocation lists for checking (.crl, optional)', { exact: true }).setInputFiles('tests/fixtures/test-ca.crl');
  download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Add long-term validation data and save copy', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Signature status' })).toContainText('1 revocation list(s)');
  await openBytes('signed-ltv.pdf', await readFile((await (await download).path())!));
  await page.getByLabel('Revocation lists for checking (.crl, optional)', { exact: true }).setInputFiles([]);
  await page.getByRole('button', { name: 'Check signatures in this PDF', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Signatures in this PDF' })).toContainText('VALID · TRUSTED · not revoked (CRL)');
});
