import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { readPkcs12, signPdf, verifyPdfSignatures } from '../apps/opendraft/src/pdf-signature.ts';

const p12 = new Uint8Array(await readFile('tests/fixtures/test-signer.p12'));
async function drawing() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600, 400]).drawText('ISSUED FOR CONSTRUCTION', { x: 40, y: 340, size: 18, font }); pdf.addPage([600, 400]);
  return pdf.save();
}

test('a PKCS#12 identity signs a copy that verifies, with signer name, time and reason', async () => {
  const identity = await readPkcs12(p12, 'opendraft-test');
  assert.equal(identity.signerName, 'OpenDraft Test Signer');
  const when = new Date('2026-10-22T12:00:00Z');
  const signed = await signPdf(await drawing(), identity, { reason: 'Approved for issue', location: 'Boston', pageIndex: 1, visibleRect: [380, 30, 580, 90], signingTime: when });
  const [report] = await verifyPdfSignatures(signed);
  assert.equal(report.integrity, 'valid');
  assert.equal(report.coversWholeFile, true);
  assert.equal(report.signer, 'OpenDraft Test Signer');
  assert.equal(report.signingTime, when.toISOString());
  assert.equal(report.reason, 'Approved for issue');
  assert.equal(report.trust, 'not-checked');
  const doc = await PDFDocument.load(signed);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getPage(1).node.Annots().size(), 1);
});

test('any change to signed bytes is detected; appended bytes are reported as a later change', async () => {
  const signed = await signPdf(await drawing(), await readPkcs12(p12, 'opendraft-test'));
  const tampered = signed.slice(); const at = Buffer.from(tampered).indexOf('ISSUED') >= 0 ? Buffer.from(tampered).indexOf('/MediaBox') + 12 : 200;
  tampered[at] = tampered[at] === 0x30 ? 0x31 : 0x30;
  assert.equal((await verifyPdfSignatures(tampered))[0].integrity, 'invalid');
  const extended = new Uint8Array([...signed, ...Buffer.from('\n% appended after signing\n')]);
  const [later] = await verifyPdfSignatures(extended);
  assert.equal(later.integrity, 'valid'); assert.equal(later.coversWholeFile, false);
  assert.match(later.detail, /changed or extended after signing/);
});

test('wrong passwords, unsigned files and re-signing are handled explicitly', async () => {
  await assert.rejects(readPkcs12(p12, 'wrong'), /Wrong password/);
  await assert.rejects(readPkcs12(new Uint8Array([1, 2, 3]), 'x'), /PKCS#12|password|damaged/);
  assert.deepEqual(await verifyPdfSignatures(await drawing()), []);
  const identity = await readPkcs12(p12, 'opendraft-test');
  await assert.rejects(signPdf(await drawing(), identity, { visibleRect: [0, 0, 10, 10] }), /at least 60 x 24/);
});

test('a second signature is appended incrementally; both verify and the original bytes are untouched', async () => {
  const identity = await readPkcs12(p12, 'opendraft-test');
  const original = await drawing();
  const first = await signPdf(original, identity, { reason: 'Designed' });
  assert.deepEqual(first.subarray(0, original.length), original);
  const second = await signPdf(first, identity, { reason: 'Checked', pageIndex: 1, visibleRect: [380, 30, 580, 90] });
  assert.deepEqual(second.subarray(0, first.length), first);
  const reports = await verifyPdfSignatures(second);
  assert.deepEqual(reports.map(r => [r.integrity, r.coversWholeFile, r.reason]), [['valid', false, 'Designed'], ['valid', true, 'Checked']]);
});

test('sources with compressed cross-reference streams are updated with a matching xref stream', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 200]);
  const compressed = await pdf.save({ useObjectStreams: true });
  const signed = await signPdf(compressed, await readPkcs12(p12, 'opendraft-test'));
  assert.match(Buffer.from(signed.subarray(compressed.length)).toString('latin1'), /\/Type \/XRef/);
  assert.equal((await verifyPdfSignatures(signed))[0].integrity, 'valid');
  assert.equal((await PDFDocument.load(signed)).getPageCount(), 1);
});

test('certification sets DocMDP; level 1 forbids further signatures; empty fields can be signed', async () => {
  const identity = await readPkcs12(p12, 'opendraft-test');
  const certified = await signPdf(await drawing(), identity, { certify: 1 });
  const doc = await PDFDocument.load(certified);
  assert.ok(doc.catalog.lookup(PDFName.of('Perms')));
  await assert.rejects(signPdf(certified, identity), /no changes allowed/);
  const level2 = await signPdf(await drawing(), identity, { certify: 2 });
  await assert.rejects(signPdf(level2, identity, { certify: 2 }), /first signature/);
  assert.equal((await verifyPdfSignatures(await signPdf(level2, identity))).filter(r => r.integrity === 'valid').length, 2);
  const { addFormField } = await import('../apps/opendraft/src/pdf-forms.ts');
  const withField = await addFormField(await drawing(), { type: 'signature', name: 'Engineer', pageIndex: 0, rect: [300, 20, 560, 80] });
  const fieldSigned = await signPdf(withField, identity, { field: 'Engineer', visibleRect: [300, 20, 560, 80] });
  const [report] = await verifyPdfSignatures(fieldSigned);
  assert.equal(report.field, 'Engineer'); assert.equal(report.integrity, 'valid');
  await assert.rejects(signPdf(fieldSigned, identity, { field: 'Engineer' }), /already signed/);
  await assert.rejects(signPdf(withField, identity, { field: 'Nope' }), /no signature field named/);
});

test('trust is reported against caller-supplied trusted certificates; certification level is reported', async () => {
  const { readCertificates } = await import('../apps/opendraft/src/pdf-signature.ts');
  const identity = await readPkcs12(p12, 'opendraft-test');
  const signed = await signPdf(await drawing(), identity, { certify: 2 });
  const [plain] = await verifyPdfSignatures(signed);
  assert.equal(plain.trust, 'not-checked'); assert.equal(plain.certification, 2);
  const [trusted] = await verifyPdfSignatures(signed, { trusted: readCertificates(new Uint8Array(await readFile('tests/fixtures/test-signer-cert.pem'))) });
  assert.equal(trusted.trust, 'trusted');
  const [untrusted] = await verifyPdfSignatures(signed, { trusted: readCertificates(new Uint8Array(await readFile('tests/fixtures/other-ca.pem'))) });
  assert.equal(untrusted.trust, 'untrusted'); assert.match(untrusted.trustDetail, /Not trusted/);
  assert.throws(() => readCertificates(new Uint8Array([1, 2, 3])), /could not be read/);
});

test('an RFC 3161 timestamp is attached to the signature and verified against the signature value', async () => {
  const { testTsa } = await import('./tsa-fixture.mjs');
  const identity = await readPkcs12(p12, 'opendraft-test');
  const signed = await signPdf(await drawing(), identity, { timestamp: testTsa(identity) });
  const [report] = await verifyPdfSignatures(signed);
  assert.equal(report.integrity, 'valid');
  assert.equal(report.timestamp, '2026-10-22T12:00:00.000Z');
  assert.equal(report.timestampValid, true);
  const refused = async () => { const pkijs = await import('pkijs'); return new Uint8Array(new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: 2 }) }).toSchema().toBER(false)); };
  await assert.rejects(signPdf(await drawing(), identity, { timestamp: refused }), /refused the request \(status 2\)/);
  const [plain] = await verifyPdfSignatures(await signPdf(await drawing(), identity));
  assert.equal(plain.timestamp, undefined);
});

test('revocation lists: a revoked signer is reported, a good one passes, and a foreign or forged list is not trusted', async () => {
  const { readCertificates, readCrls } = await import('../apps/opendraft/src/pdf-signature.ts');
  const ca = readCertificates(new Uint8Array(await readFile('tests/fixtures/test-ca.pem'))), crls = readCrls(new Uint8Array(await readFile('tests/fixtures/test-ca.crl')));
  const sign = async file => signPdf(await drawing(), await readPkcs12(new Uint8Array(await readFile(`tests/fixtures/${file}`)), 'opendraft-test'));
  const [good] = await verifyPdfSignatures(await sign('test-ca-signer-good.p12'), { trusted: ca, crls });
  assert.deepEqual([good.signer, good.trust, good.revocation], ['OpenDraft Test Signer (good)', 'trusted', 'good']);
  const [revoked] = await verifyPdfSignatures(await sign('test-ca-signer-revoked.p12'), { trusted: ca, crls });
  assert.equal(revoked.revocation, 'revoked'); assert.match(revoked.revocationDetail, /revoked \d{4}-\d{2}-\d{2}/);
  // A list from another issuer does not apply to this signer.
  const [other] = await verifyPdfSignatures(await sign('test-ca-signer-revoked.p12'), { crls: [] });
  assert.equal(other.revocation, undefined);
  const [selfSigned] = await verifyPdfSignatures(await signPdf(await drawing(), await readPkcs12(p12, 'opendraft-test')), { crls });
  assert.equal(selfSigned.revocation, 'not-checked');
  assert.throws(() => readCrls(new Uint8Array([9, 9, 9])), /could not be read/);
});

test('long-term validation data is embedded incrementally and used for revocation without external files', async () => {
  const { embedValidationData, readCertificates, readCrls } = await import('../apps/opendraft/src/pdf-signature.ts');
  const ca = readCertificates(new Uint8Array(await readFile('tests/fixtures/test-ca.pem'))), crls = readCrls(new Uint8Array(await readFile('tests/fixtures/test-ca.crl')));
  for (const [file, expected] of [['test-ca-signer-good.p12', 'good'], ['test-ca-signer-revoked.p12', 'revoked']]) {
    const signed = await signPdf(await drawing(), await readPkcs12(new Uint8Array(await readFile(`tests/fixtures/${file}`)), 'opendraft-test'));
    const ltv = await embedValidationData(signed, { certificates: ca, crls });
    assert.deepEqual(ltv.subarray(0, signed.length), signed, 'appended, original bytes intact');
    const [report] = await verifyPdfSignatures(ltv, { trusted: ca }); // no CRL supplied: it comes from the DSS
    assert.deepEqual([report.integrity, report.trust, report.revocation], ['valid', 'trusted', expected]);
    const again = await embedValidationData(ltv, { crls }); // idempotent: no duplicate entries
    const doc = await PDFDocument.load(again);
    assert.equal(doc.catalog.lookup(PDFName.of('DSS')).lookup(PDFName.of('CRLs')).size(), 1);
  }
  await assert.rejects(embedValidationData(await drawing()), /no signatures/);
});

test('OCSP: a live responder reports good and revoked signers; embedded responses then work offline', async t => {
  const { startTestOcspResponder } = await import('./ocsp-responder.mjs');
  const { embedValidationData, readCertificates, ocspUrl } = await import('../apps/opendraft/src/pdf-signature.ts');
  const responder = await startTestOcspResponder(); t.after(() => responder.stop());
  const ca = readCertificates(new Uint8Array(await readFile('tests/fixtures/test-ca.pem')));
  const urls = [];
  for (const [file, expected] of [['test-ca-signer-good.p12', 'good'], ['test-ca-signer-revoked.p12', 'revoked']]) {
    const identity = await readPkcs12(new Uint8Array(await readFile(`tests/fixtures/${file}`)), 'opendraft-test');
    assert.equal(ocspUrl(identity.certificate), 'http://127.0.0.1:4199/');
    const signed = await signPdf(await drawing(), identity);
    const [live] = await verifyPdfSignatures(signed, { trusted: ca, ocsp: async (url, request) => { urls.push(url); return responder.fetchOcsp(url, request); } });
    assert.deepEqual([live.revocation, live.revocationSource], [expected, 'ocsp']);
    // Embed the response; afterwards no network is needed (the fetcher must not be called).
    const ltv = await embedValidationData(signed, { certificates: ca, ocsps: [live.ocspResponse] });
    const [offline] = await verifyPdfSignatures(ltv, { trusted: ca, ocsp: async () => { throw new Error('network must not be used'); } });
    assert.deepEqual([offline.revocation, offline.revocationSource], [expected, 'ocsp']);
  }
  assert.deepEqual(urls, ['http://127.0.0.1:4199/', 'http://127.0.0.1:4199/']);
  // A response for a different certificate is never accepted as this certificate's status.
  const goodSigned = await signPdf(await drawing(), await readPkcs12(new Uint8Array(await readFile('tests/fixtures/test-ca-signer-good.p12')), 'opendraft-test'));
  const revokedSigned = await signPdf(await drawing(), await readPkcs12(new Uint8Array(await readFile('tests/fixtures/test-ca-signer-revoked.p12')), 'opendraft-test'));
  const [revokedReport] = await verifyPdfSignatures(revokedSigned, { trusted: ca, ocsp: responder.fetchOcsp });
  const [mismatch] = await verifyPdfSignatures(goodSigned, { trusted: ca, ocspResponses: [revokedReport.ocspResponse] });
  assert.notEqual(mismatch.revocation, 'revoked');
});

test('an archival document timestamp seals the signed file and its validation data (PAdES-LTA)', async () => {
  const { testTsa } = await import('./tsa-fixture.mjs');
  const { addDocumentTimestamp, embedValidationData, readCertificates, readCrls } = await import('../apps/opendraft/src/pdf-signature.ts');
  const ca = readCertificates(new Uint8Array(await readFile('tests/fixtures/test-ca.pem'))), crls = readCrls(new Uint8Array(await readFile('tests/fixtures/test-ca.crl')));
  const identity = await readPkcs12(new Uint8Array(await readFile('tests/fixtures/test-ca-signer-good.p12')), 'opendraft-test');
  const ltv = await embedValidationData(await signPdf(await drawing(), identity), { certificates: ca, crls });
  const lta = await addDocumentTimestamp(ltv, testTsa(identity, new Date('2026-10-22T12:00:00Z')));
  assert.deepEqual(lta.subarray(0, ltv.length), ltv);
  const reports = await verifyPdfSignatures(lta, { trusted: ca });
  assert.deepEqual(reports.map(r => [r.kind ?? 'signature', r.integrity, r.coversWholeFile]), [['signature', 'valid', false], ['document-timestamp', 'valid', true]]);
  assert.equal(reports[1].timestamp, '2026-10-22T12:00:00.000Z');
  assert.equal(reports[0].revocation, 'good');
  // Any change before the timestamp breaks it.
  const tampered = lta.slice(); const at = Buffer.from(tampered).indexOf('/MediaBox') + 12; tampered[at] = tampered[at] === 0x30 ? 0x31 : 0x30;
  assert.equal((await verifyPdfSignatures(tampered))[1].integrity, 'invalid');
});
