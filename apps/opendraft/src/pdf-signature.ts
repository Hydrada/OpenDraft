import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { appendIncrementalUpdate, snapshot } from './incremental.ts';

/** Space reserved for the CMS signature (DER, hex-encoded twice the size). Fits RSA-4096 plus a chain. */
export const SIGNATURE_BYTES = 16_384;
const BYTE_RANGE_PLACEHOLDER = '**********';
const OID = { sha256: '2.16.840.1.101.3.4.2.1', timestampToken: '1.2.840.113549.1.9.16.2.14', tstInfo: '1.2.840.113549.1.9.16.1.4', data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5', keyBag: '1.2.840.113549.1.12.10.1.1', shroudedKeyBag: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3', rsa: '1.2.840.113549.1.1.1', ec: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34', commonName: '2.5.4.3' } as const;

export type SigningIdentity = { privateKey: CryptoKey; certificate: pkijs.Certificate; chain: pkijs.Certificate[]; signerName: string };
/** certify: DocMDP permission level for a first, certifying signature (1 no changes, 2 form filling and signing, 3 also annotations). field: sign an existing empty signature field by name. */
/** timestamp: sends a DER RFC 3161 TimeStampReq and returns the DER TimeStampResp (e.g. through the self-host server). */
export type SignOptions = { reason?: string; location?: string; pageIndex?: number; visibleRect?: [number, number, number, number]; signingTime?: Date; certify?: 1 | 2 | 3; field?: string; timestamp?: (query: Uint8Array) => Promise<Uint8Array> };
export type SignatureReport = { field: string; signer: string; signingTime?: string; integrity: 'valid' | 'invalid'; coversWholeFile: boolean; reason?: string; trust: 'trusted' | 'untrusted' | 'not-checked'; trustDetail?: string; certification?: 1 | 2 | 3; kind?: 'signature' | 'document-timestamp'; timestamp?: string; timestampValid?: boolean; revocation?: 'good' | 'revoked' | 'not-checked'; revocationDetail?: string; revocationSource?: 'crl' | 'ocsp'; ocspResponse?: Uint8Array; detail: string };

const engine = () => { const crypto = globalThis.crypto; if (!crypto?.subtle) throw new Error('Web Crypto is not available.'); pkijs.setEngine('opendraft', new pkijs.CryptoEngine({ name: 'opendraft', crypto })); return crypto; };
const ascii = (value: string) => new TextEncoder().encode(value);
const latin1 = (bytes: Uint8Array) => { let out = ''; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return out; };
const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
function commonName(name: pkijs.RelativeDistinguishedNames): string {
  const cn = name.typesAndValues.find(item => item.type === OID.commonName);
  return cn ? String(cn.value.valueBlock.value) : name.typesAndValues.map(item => String(item.value.valueBlock.value)).join(', ');
}

/** Reads a password-protected PKCS#12 (.p12/.pfx) file: the private key and its certificate chain. */
export async function readPkcs12(bytes: Uint8Array, password: string): Promise<SigningIdentity> {
  const crypto = engine();
  const asn1 = asn1js.fromBER(buffer(bytes));
  if (asn1.offset === -1) throw new Error('The certificate file is not a valid PKCS#12 (.p12/.pfx) file.');
  const pass = buffer(ascii(password));
  const pfx = new pkijs.PFX({ schema: asn1.result });
  try {
    await pfx.parseInternalValues({ password: pass, checkIntegrity: true });
    const safe = pfx.parsedValue!.authenticatedSafe!;
    await safe.parseInternalValues({ safeContents: safe.safeContents.map(() => ({ password: pass })) });
    let keyInfo: pkijs.PrivateKeyInfo | undefined; const certificates: pkijs.Certificate[] = [];
    for (const content of safe.parsedValue!.safeContents) for (const bag of content.value.safeBags) {
      if (bag.bagId === OID.shroudedKeyBag) { // Public in pkijs's documented PKCS#12 workflow, but typed protected; call it through a narrow cast.
        const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
        await (shrouded as unknown as { parseInternalValues(parameters: { password: ArrayBuffer }): Promise<void> }).parseInternalValues({ password: pass });
        keyInfo = shrouded.parsedValue; }
      else if (bag.bagId === OID.keyBag) keyInfo = bag.bagValue as unknown as pkijs.PrivateKeyInfo;
      else if (bag.bagId === OID.certBag) { const cert = (bag.bagValue as pkijs.CertBag).parsedValue; if (cert instanceof pkijs.Certificate) certificates.push(cert); }
    }
    if (!keyInfo || !certificates.length) throw new Error('The certificate file must contain a private key and its certificate.');
    // The signer is the certificate that issued no other certificate in the file (the leaf).
    const leaf = certificates.find(cert => !certificates.some(other => other !== cert && other.issuer.isEqual(cert.subject) && !other.subject.isEqual(cert.subject))) ?? certificates[0];
    const algorithm = keyInfo.privateKeyAlgorithm.algorithmId;
    let importAlgorithm: RsaHashedImportParams | EcKeyImportParams;
    if (algorithm === OID.rsa) importAlgorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    else if (algorithm === OID.ec) {
      const curve = (keyInfo.privateKeyAlgorithm.algorithmParams as asn1js.ObjectIdentifier).valueBlock.toString();
      importAlgorithm = { name: 'ECDSA', namedCurve: curve === OID.p256 ? 'P-256' : curve === OID.p384 ? 'P-384' : (() => { throw new Error('Only P-256 and P-384 elliptic-curve keys are supported.'); })() };
    } else throw new Error('Only RSA and elliptic-curve signing keys are supported.');
    const privateKey = await crypto.subtle.importKey('pkcs8', keyInfo.toSchema().toBER(false), importAlgorithm, false, ['sign']);
    return { privateKey, certificate: leaf, chain: certificates.filter(cert => cert !== leaf), signerName: commonName(leaf.subject) };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(/password|integrity|MAC|decrypt|Integrity/i.test(text) ? 'Wrong password, or the certificate file is damaged.' : text);
  }
}

function existingSignatures(pdf: PDFDocument): PDFDict[] {
  const form = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = form?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const out: PDFDict[] = [];
  const walk = (array: PDFArray | undefined, depth = 0) => {
    if (!array || depth > 20) return;
    for (const item of array.asArray()) {
      const field = pdf.context.lookup(item);
      if (!(field instanceof PDFDict)) continue;
      const value = field.lookup(PDFName.of('V'));
      if (String(field.lookup(PDFName.of('FT'))) === '/Sig' && value instanceof PDFDict) out.push(field);
      walk(field.lookupMaybe(PDFName.of('Kids'), PDFArray), depth + 1);
    }
  };
  walk(fields);
  return out;
}

/** Appends the update, fills in the real /ByteRange and returns the bytes it covers. */
async function prepareByteRange(bytes: Uint8Array, pdf: PDFDocument, before: ReturnType<typeof snapshot>) {
  const out = await appendIncrementalUpdate(bytes, pdf, before);
  const raw = latin1(out.subarray(bytes.length)), base = bytes.length;
  const found = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/.exec(raw);
  const holeAt = raw.indexOf(`<${'0'.repeat(SIGNATURE_BYTES * 2)}>`);
  if (!found || holeAt < 0) throw new Error('Could not prepare the signature placeholder.');
  const start = holeAt + base, end = start + SIGNATURE_BYTES * 2 + 2;
  const range = `/ByteRange [0 ${start} ${end} ${out.length - end}]`;
  if (range.length > found[0].length) throw new Error('Signature byte range does not fit its placeholder.');
  out.set(ascii(range.padEnd(found[0].length, ' ')), found.index + base);
  const signed = new Uint8Array(start + out.length - end);
  signed.set(out.subarray(0, start)); signed.set(out.subarray(end), start);
  return { out, signed, start };
}
const placeholderDict = (pdf: PDFDocument) => {
  const byteRange = PDFArray.withContext(pdf.context);
  byteRange.push(PDFNumber.of(0)); for (let i = 0; i < 3; i++) byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  return { ByteRange: byteRange, Contents: PDFHexString.of('0'.repeat(SIGNATURE_BYTES * 2)) };
};
const writeContents = (out: Uint8Array, start: number, der: Uint8Array) => {
  if (der.length > SIGNATURE_BYTES) throw new Error('The signature is larger than the reserved space.');
  out.set(ascii(Array.from(der, byte => byte.toString(16).padStart(2, '0')).join('').padEnd(SIGNATURE_BYTES * 2, '0')), start + 1);
};

/**
 * Archival document timestamp (PAdES-LTA): an RFC 3161 timestamp over the whole file so far,
 * including earlier signatures and their long-term validation data, appended incrementally.
 * Re-applying it before the TSA certificate expires keeps the evidence verifiable indefinitely.
 */
export async function addDocumentTimestamp(bytes: Uint8Array, timestamp: (query: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const crypto = engine();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const before = snapshot(pdf, bytes);
  const signature = pdf.context.register(pdf.context.obj({ Type: 'DocTimeStamp', Filter: 'Adobe.PPKLite', SubFilter: 'ETSI.RFC3161', ...placeholderDict(pdf) }));
  let name = 'DocumentTimestamp1'; const taken = new Set(pdf.getForm().getFields().map(field => field.getName()));
  for (let n = 2; taken.has(name); n++) name = `DocumentTimestamp${n}`;
  const page = pdf.getPage(0);
  const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], V: signature, T: PDFString.of(name), F: 132, P: page.ref }));
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(widget); else page.node.set(PDFName.of('Annots'), pdf.context.obj([widget]));
  let form = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!form) { form = pdf.context.obj({ Fields: [] }) as PDFDict; pdf.catalog.set(PDFName.of('AcroForm'), form); }
  const fields = form.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (fields) fields.push(widget); else form.set(PDFName.of('Fields'), pdf.context.obj([widget]));
  form.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const { out, signed, start } = await prepareByteRange(bytes, pdf, before);
  const digest = await crypto.subtle.digest('SHA-256', signed);
  const query = new pkijs.TimeStampReq({ version: 1, messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }), hashedMessage: new asn1js.OctetString({ valueHex: digest }) }), nonce: new asn1js.Integer({ valueHex: crypto.getRandomValues(new Uint8Array(8)).buffer }), certReq: true });
  const response = new pkijs.TimeStampResp({ schema: asn1js.fromBER(buffer(await timestamp(new Uint8Array(query.toSchema().toBER(false))))).result });
  if (response.status.status > 1 || !response.timeStampToken) throw new Error(`The timestamp authority refused the request (status ${response.status.status}).`);
  writeContents(out, start, new Uint8Array(response.timeStampToken.toSchema().toBER(false)));
  return out;
}

/**
 * Signs a copy of the PDF with a detached CMS signature (adbe.pkcs7.detached; SHA-256) covering the
 * whole file except the signature value. A visible appearance is optional. Documents that already
 * carry a signature are refused: adding another needs an incremental update to keep the first valid.
 */
export async function signPdf(bytes: Uint8Array, identity: SigningIdentity, options: SignOptions = {}): Promise<Uint8Array> {
  const crypto = engine();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const before = snapshot(pdf, bytes), alreadySigned = existingSignatures(pdf);
  // A certified document limits later changes: level 1 allows none, so no further signatures.
  const perms = pdf.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict), docMdp = perms?.lookupMaybe(PDFName.of('DocMDP'), PDFDict);
  const level = docMdp?.lookupMaybe(PDFName.of('Reference'), PDFArray)?.asArray().map(item => pdf.context.lookup(item)).find((item): item is PDFDict => item instanceof PDFDict)?.lookupMaybe(PDFName.of('TransformParams'), PDFDict)?.lookupMaybe(PDFName.of('P'), PDFNumber)?.asNumber() ?? (docMdp ? 2 : undefined);
  if (level === 1) throw new Error('This PDF is certified with "no changes allowed"; it cannot be signed again.');
  if (options.certify !== undefined && alreadySigned.length) throw new Error('Only the first signature can certify a document.');
  const pageIndex = options.pageIndex ?? 0;
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.getPageCount()) throw new Error('Signature page does not exist.');
  const page = pdf.getPage(pageIndex), when = options.signingTime ?? new Date();
  const text = (value: string | undefined) => value?.trim() ? PDFHexString.fromText(value.trim().slice(0, 500)) : undefined;
  const signature = pdf.context.register(pdf.context.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ...placeholderDict(pdf), M: PDFString.fromDate(when), Name: PDFHexString.fromText(identity.signerName),
    ...(text(options.reason) ? { Reason: text(options.reason)! } : {}), ...(text(options.location) ? { Location: text(options.location)! } : {}),
  }));
  let rect: [number, number, number, number] = [0, 0, 0, 0], appearance: PDFRef | undefined;
  if (options.visibleRect) {
    const [x1, y1, x2, y2] = options.visibleRect, l = Math.min(x1, x2), b = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (![x1, y1, x2, y2].every(Number.isFinite) || w < 60 || h < 24) throw new Error('Visible signature box must be at least 60 x 24 points.');
    rect = [l, b, l + w, b + h];
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = [`Digitally signed by ${identity.signerName}`, `Date: ${when.toISOString().replace('T', ' ').slice(0, 19)} UTC`, ...(options.reason?.trim() ? [`Reason: ${options.reason.trim()}`] : [])];
    const size = Math.max(5, Math.min(10, (h - 6) / (lines.length * 1.25), ...lines.map(line => (w - 8) / Math.max(1, font.widthOfTextAtSize(line, 1)))));
    const safe = (line: string) => { try { return font.encodeText(line).toString(); } catch { return font.encodeText(line.replace(/[^\x20-\x7e]/g, '?')).toString(); } };
    const commands = ['q 0.1 0.25 0.45 RG 1 w 0.5 0.5 ' + (w - 1) + ' ' + (h - 1) + ' re S', 'BT /F0 ' + size.toFixed(2) + ' Tf 0.1 0.25 0.45 rg', ...lines.map((line, i) => `1 0 0 1 4 ${(h - 4 - size * (i + 1) * 1.15).toFixed(2)} Tm ${safe(line)} Tj`), 'ET Q'];
    appearance = pdf.context.register(pdf.context.flateStream(commands.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: { Font: { F0: font.ref } } }));
  }
  let form = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!form) { form = pdf.context.obj({ Fields: [] }) as PDFDict; pdf.catalog.set(PDFName.of('AcroForm'), form); }
  if (options.field !== undefined) {
    // Sign into an existing, empty signature field (e.g. one placed with the form designer).
    const field = pdf.getForm().getFields().find(item => item.getName() === options.field);
    const dict = field?.acroField.dict;
    if (!dict || String(dict.lookup(PDFName.of('FT'))) !== '/Sig') throw new Error(`There is no signature field named "${options.field}".`);
    if (dict.has(PDFName.of('V'))) throw new Error(`Signature field "${options.field}" is already signed.`);
    dict.set(PDFName.of('V'), signature);
    if (appearance) dict.set(PDFName.of('AP'), pdf.context.obj({ N: appearance }));
  } else {
    let name = 'Signature1'; const taken = new Set(pdf.getForm().getFields().map(field => field.getName()));
    for (let n = 2; taken.has(name); n++) name = `Signature${n}`;
    const widget = pdf.context.register(pdf.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, V: signature, T: PDFString.of(name), F: 132, P: page.ref,
      ...(appearance ? { AP: { N: appearance } } : {}),
    }));
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) annots.push(widget); else page.node.set(PDFName.of('Annots'), pdf.context.obj([widget]));
    const fields = form.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (fields) fields.push(widget); else form.set(PDFName.of('Fields'), pdf.context.obj([widget]));
  }
  form.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  if (options.certify !== undefined) {
    if (![1, 2, 3].includes(options.certify)) throw new Error('Certification level must be 1, 2 or 3.');
    const sigDict = pdf.context.lookup(signature, PDFDict);
    sigDict.set(PDFName.of('Reference'), pdf.context.obj([{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: options.certify, V: '1.2' } }]));
    pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({ DocMDP: signature }));
  }

  // Appended as an incremental update: the original bytes (and earlier signatures) stay intact.
  const { out, signed, start } = await prepareByteRange(bytes, pdf, before);


  const digest = await crypto.subtle.digest('SHA-256', signed);
  const cms = new pkijs.SignedData({
    version: 1, encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [new pkijs.SignerInfo({ version: 1, sid: new pkijs.IssuerAndSerialNumber({ issuer: identity.certificate.issuer, serialNumber: identity.certificate.serialNumber }) })],
    certificates: [identity.certificate, ...identity.chain],
  });
  cms.signerInfos[0].signedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: [
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.signingTime, values: [new asn1js.UTCTime({ valueDate: when })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: digest })] }),
  ] });
  await cms.sign(identity.privateKey, 0, 'SHA-256');
  if (options.timestamp) {
    // RFC 3161: timestamp the signature value itself, attached as an unsigned attribute.
    const signatureValue = cms.signerInfos[0].signature.valueBlock.valueHexView;
    const imprint = await crypto.subtle.digest('SHA-256', signatureValue.slice());
    const nonce = crypto.getRandomValues(new Uint8Array(8));
    const query = new pkijs.TimeStampReq({ version: 1, messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }), hashedMessage: new asn1js.OctetString({ valueHex: imprint }) }), nonce: new asn1js.Integer({ valueHex: nonce.buffer }), certReq: true });
    const reply = await options.timestamp(new Uint8Array(query.toSchema().toBER(false)));
    const response = new pkijs.TimeStampResp({ schema: asn1js.fromBER(buffer(reply)).result });
    if (response.status.status > 1 || !response.timeStampToken) throw new Error(`The timestamp authority refused the request (status ${response.status.status}).`);
    cms.signerInfos[0].unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 1, attributes: [new pkijs.Attribute({ type: OID.timestampToken, values: [response.timeStampToken.toSchema()] })] });
  }
  const der = new Uint8Array(new pkijs.ContentInfo({ contentType: OID.signedData, content: cms.toSchema(true) }).toSchema().toBER(false));
  if (der.length > SIGNATURE_BYTES) throw new Error('The signature is larger than the reserved space.');
  const hex = Array.from(der, byte => byte.toString(16).padStart(2, '0')).join('').padEnd(SIGNATURE_BYTES * 2, '0');
  out.set(ascii(hex), start + 1);
  return out;
}

/** Parses a timestamp token's TSTInfo and checks the token's own signature over it. */
async function verifiedTstInfo(tokenData: pkijs.SignedData): Promise<{ info: pkijs.TSTInfo; valid: boolean } | undefined> {
  if (tokenData.encapContentInfo.eContentType !== OID.tstInfo || !tokenData.encapContentInfo.eContent) return undefined;
  const content = tokenData.encapContentInfo.eContent;
  const chunks: Uint8Array[] = content.idBlock.isConstructed ? (content.valueBlock.value as asn1js.OctetString[]).map(part => part.valueBlock.valueHexView) : [content.valueBlock.valueHexView];
  const bytes = new Uint8Array(chunks.reduce((total, part) => total + part.length, 0)); let at = 0; for (const part of chunks) { bytes.set(part, at); at += part.length; }
  const info = new pkijs.TSTInfo({ schema: asn1js.fromBER(bytes.buffer).result });
  // pkijs's TSTInfo shortcut rejects chunked content; verify the token signature over the exact TSTInfo bytes.
  // (Mutates the parsed token: callers must not reuse it afterwards.)
  tokenData.encapContentInfo.eContentType = OID.data; delete (tokenData.encapContentInfo as { eContent?: unknown }).eContent;
  const valid = await tokenData.verify({ signer: 0, data: bytes.buffer, checkChain: false }).catch(() => false);
  return { info, valid: !!valid };
}

/** Reads trusted certificates (DER, or PEM with one or more BEGIN CERTIFICATE blocks). */
export function readCertificates(bytes: Uint8Array): pkijs.Certificate[] {
  const text = latin1(bytes);
  const ders = text.includes('-----BEGIN CERTIFICATE-----')
    ? [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(match => Uint8Array.from(atob(match[1].replace(/\s+/g, '')), c => c.charCodeAt(0)))
    : [bytes];
  return ders.map(der => { const asn1 = asn1js.fromBER(buffer(der)); if (asn1.offset === -1) throw new Error('A trusted certificate file could not be read.'); return new pkijs.Certificate({ schema: asn1.result }); });
}

/** Reads certificate revocation lists (DER, or PEM with BEGIN X509 CRL blocks). */
export function readCrls(bytes: Uint8Array): pkijs.CertificateRevocationList[] {
  const text = latin1(bytes);
  const ders = text.includes('-----BEGIN X509 CRL-----')
    ? [...text.matchAll(/-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/g)].map(match => Uint8Array.from(atob(match[1].replace(/\s+/g, '')), c => c.charCodeAt(0)))
    : [bytes];
  return ders.map(der => { const asn1 = asn1js.fromBER(buffer(der)); if (asn1.offset === -1) throw new Error('A revocation list could not be read.'); return new pkijs.CertificateRevocationList({ schema: asn1.result }); });
}

/** Sends a DER OCSP request to a responder URL and returns the DER OCSP response (e.g. via the self-host server). */
export type OcspFetch = (url: string, request: Uint8Array) => Promise<Uint8Array>;
const OCSP_ACCESS = '1.3.6.1.5.5.7.48.1', AIA = '1.3.6.1.5.5.7.1.1';
/** OCSP responder URL from the certificate's Authority Information Access extension. */
export function ocspUrl(certificate: pkijs.Certificate): string | undefined {
  const aia = certificate.extensions?.find(extension => extension.extnID === AIA)?.parsedValue as pkijs.InfoAccess | undefined;
  const location = aia?.accessDescriptions.find(item => item.accessMethod === OCSP_ACCESS)?.accessLocation;
  return location?.type === 6 && typeof location.value === 'string' && /^https?:\/\//i.test(location.value) ? location.value : undefined;
}
/** Checks one OCSP response for `certificate`; undefined when it is not about this certificate or not authentic. */
async function ocspStatus(response: Uint8Array, certificate: pkijs.Certificate, issuer: pkijs.Certificate, trusted: pkijs.Certificate[]): Promise<{ status: 'good' | 'revoked' | 'unknown'; detail: string } | undefined> {
  try {
    const parsed = new pkijs.OCSPResponse({ schema: asn1js.fromBER(buffer(response)).result });
    if (parsed.responseStatus.valueBlock.valueDec !== 0 || !parsed.responseBytes) return undefined;
    const basic = new pkijs.BasicOCSPResponse({ schema: asn1js.fromBER(parsed.responseBytes.response.valueBlock.valueHexView.slice().buffer).result });
    // Authentic only if signed by the issuer or a responder it delegated (RFC 6960 4.2.2.2).
    if (!(await basic.verify({ trustedCerts: [issuer, ...trusted], issuerCerts: [issuer] }))) return undefined;
    const result = await basic.getCertificateStatus(certificate, issuer);
    if (!result.isForCertificate) return undefined;
    const produced = basic.tbsResponseData.producedAt.toISOString().slice(0, 10);
    return result.status === 0 ? { status: 'good', detail: `Not revoked according to the OCSP responder (${produced}).` }
      : result.status === 1 ? { status: 'revoked', detail: `Revoked according to the OCSP responder (${produced}).` }
      : { status: 'unknown', detail: 'The OCSP responder does not know this certificate.' };
  } catch { return undefined; }
}

/** Validation material embedded in the PDF's Document Security Store (PAdES long-term validation). */
export type ValidationData = { certificates: pkijs.Certificate[]; crls: pkijs.CertificateRevocationList[]; ocsps: Uint8Array[] };
const streamBytes = (pdf: PDFDocument, item: unknown): Uint8Array | undefined => {
  const object = item instanceof PDFRef ? pdf.context.lookup(item) : item;
  return object instanceof PDFRawStream ? decodePDFRawStream(object).decode() : undefined;
};
export function readValidationData(pdf: PDFDocument): ValidationData {
  const dss = pdf.catalog.lookupMaybe(PDFName.of('DSS'), PDFDict), out: ValidationData = { certificates: [], crls: [], ocsps: [] };
  if (!dss) return out;
  const list = (key: string) => (dss.lookupMaybe(PDFName.of(key), PDFArray)?.asArray() ?? []).map(item => streamBytes(pdf, item)).filter((bytes): bytes is Uint8Array => !!bytes);
  for (const der of list('Certs')) try { out.certificates.push(new pkijs.Certificate({ schema: asn1js.fromBER(buffer(der)).result })); } catch { /* ignore unreadable entries */ }
  for (const der of list('CRLs')) try { out.crls.push(new pkijs.CertificateRevocationList({ schema: asn1js.fromBER(buffer(der)).result })); } catch { /* ignore */ }
  out.ocsps = list('OCSPs');
  return out;
}

/**
 * Long-term validation: appends a Document Security Store holding the signers' certificate chains
 * plus the supplied revocation data (CRLs, OCSP responses) as an incremental update, so existing
 * signatures stay valid and the file can be checked after certificates expire or services vanish.
 */
export async function embedValidationData(bytes: Uint8Array, extra: { certificates?: pkijs.Certificate[]; crls?: pkijs.CertificateRevocationList[]; ocsps?: Uint8Array[] } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (!existingSignatures(pdf).length) throw new Error('This PDF has no signatures to add validation data for.');
  const before = snapshot(pdf, bytes), existing = readValidationData(pdf);
  // Every certificate carried by the signatures themselves, plus the caller's (e.g. trusted roots).
  const fromSignatures: pkijs.Certificate[] = [];
  for (const field of existingSignatures(pdf)) {
    const contents = field.lookup(PDFName.of('V'), PDFDict).lookup(PDFName.of('Contents'));
    const der = contents instanceof PDFHexString || contents instanceof PDFString ? contents.asBytes() : undefined;
    if (!der) continue;
    try { const cms = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: asn1js.fromBER(buffer(der)).result }).content }); for (const cert of cms.certificates ?? []) if (cert instanceof pkijs.Certificate) fromSignatures.push(cert); } catch { /* unreadable signature: nothing to add */ }
  }
  const unique = (items: Uint8Array[]) => { const seen = new Set<string>(); return items.filter(item => { const key = latin1(item); if (seen.has(key)) return false; seen.add(key); return true; }); };
  const der = (item: { toSchema(): asn1js.BaseBlock }) => new Uint8Array(item.toSchema().toBER(false));
  const certs = unique([...existing.certificates, ...fromSignatures, ...(extra.certificates ?? [])].map(der));
  const crls = unique([...existing.crls, ...(extra.crls ?? [])].map(der));
  const ocsps = unique([...existing.ocsps, ...(extra.ocsps ?? [])]);
  const streams = (items: Uint8Array[]) => pdf.context.obj(items.map(item => pdf.context.register(pdf.context.flateStream(item))));
  pdf.catalog.set(PDFName.of('DSS'), pdf.context.obj({ Type: 'DSS', Certs: streams(certs), CRLs: streams(crls), OCSPs: streams(ocsps) }));
  return appendIncrementalUpdate(bytes, pdf, before);
}

/**
 * Checks every signature: the CMS signature must verify against exactly the bytes its ByteRange
 * names. Certificate trust (chain to a trusted root, revocation) is not evaluated.
 */
export async function verifyPdfSignatures(bytes: Uint8Array, options: { trusted?: pkijs.Certificate[]; crls?: pkijs.CertificateRevocationList[]; at?: Date; extraCertificates?: pkijs.Certificate[]; ocsp?: OcspFetch; ocspResponses?: Uint8Array[] } = {}): Promise<SignatureReport[]> {
  engine();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const reports: SignatureReport[] = [];
  // Embedded long-term validation data supplements (never replaces) what the caller supplies.
  const embedded = readValidationData(pdf);
  options = { ...options, crls: [...(options.crls ?? []), ...embedded.crls], extraCertificates: embedded.certificates, ocspResponses: [...(options.ocspResponses ?? []), ...embedded.ocsps] } as typeof options;
  for (const field of existingSignatures(pdf)) {
    const sig = field.lookup(PDFName.of('V'), PDFDict), name = (field.lookup(PDFName.of('T')) as PDFString | PDFHexString | undefined)?.decodeText() ?? 'Signature';
    const range = sig.lookupMaybe(PDFName.of('ByteRange'), PDFArray)?.asArray().map(item => item instanceof PDFNumber ? item.asNumber() : NaN) ?? [];
    const contents = sig.lookup(PDFName.of('Contents'));
    const reason = (sig.lookup(PDFName.of('Reason')) as PDFString | PDFHexString | undefined)?.decodeText();
    const report: SignatureReport = { field: name, signer: (sig.lookup(PDFName.of('Name')) as PDFString | PDFHexString | undefined)?.decodeText() ?? 'Unknown', integrity: 'invalid', coversWholeFile: false, trust: 'not-checked', detail: '', ...(reason ? { reason } : {}) };
    try {
      if (range.length !== 4 || range.some(v => !Number.isInteger(v) || v < 0) || range[0] !== 0 || range[1] + range[2] > bytes.length + range[1] || range[2] + range[3] > bytes.length) throw new Error('Malformed signature byte range.');
      const signed = new Uint8Array(range[1] + range[3]);
      signed.set(bytes.subarray(0, range[1])); signed.set(bytes.subarray(range[2], range[2] + range[3]), range[1]);
      report.coversWholeFile = range[2] + range[3] === bytes.length;
      const der = contents instanceof PDFHexString ? contents.asBytes() : contents instanceof PDFString ? contents.asBytes() : new Uint8Array();
      const asn1 = asn1js.fromBER(buffer(der));
      const info = new pkijs.ContentInfo({ schema: asn1.result });
      const cms = new pkijs.SignedData({ schema: info.content });
      if (String(sig.lookup(PDFName.of('SubFilter'))) === '/ETSI.RFC3161') {
        // Document timestamp: the token's imprint must be the hash of exactly the covered bytes.
        report.kind = 'document-timestamp';
        const tst = await verifiedTstInfo(cms);
        const expected = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', signed));
        const actual = tst?.info.messageImprint.hashedMessage.valueBlock.valueHexView;
        const imprintOk = !!actual && actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
        const tsaCert = (cms.certificates ?? []).find((cert): cert is pkijs.Certificate => cert instanceof pkijs.Certificate);
        if (tsaCert) report.signer = commonName(tsaCert.subject);
        if (tst) { report.timestamp = tst.info.genTime.toISOString(); report.signingTime = report.timestamp; report.timestampValid = tst.valid && imprintOk; }
        report.integrity = tst?.valid && imprintOk ? 'valid' : 'invalid';
        report.detail = report.integrity === 'valid' ? (report.coversWholeFile ? 'Document timestamp: everything before it is sealed and unchanged.' : 'Document timestamp intact; later revisions were appended after it.') : 'The document timestamp does not match the file, or its token is damaged.';
        if (options.trusted?.length && tsaCert) {
          const chain = await new pkijs.CertificateChainValidationEngine({ trustedCerts: options.trusted, certs: [...(cms.certificates ?? []).filter((cert): cert is pkijs.Certificate => cert instanceof pkijs.Certificate), ...(options.extraCertificates ?? [])], checkDate: tst ? tst.info.genTime : new Date() }).verify();
          report.trust = chain.result ? 'trusted' : 'untrusted';
          report.trustDetail = chain.result ? 'Timestamp authority chains to a trusted certificate.' : `Not trusted: ${chain.resultMessage || 'no chain to a trusted certificate'}.`;
        }
        reports.push(report); continue;
      }
      const ok = await cms.verify({ signer: 0, data: buffer(signed), checkChain: false });
      // The signer is the certificate named by the SignerInfo (issuer + serial), not merely the first one.
      const sid = cms.signerInfos[0].sid, certificates = (cms.certificates ?? []).filter((cert): cert is pkijs.Certificate => cert instanceof pkijs.Certificate);
      const signerCert = (sid instanceof pkijs.IssuerAndSerialNumber ? certificates.find(cert => cert.issuer.isEqual(sid.issuer) && cert.serialNumber.isEqual(sid.serialNumber)) : undefined) ?? certificates[0];
      if (signerCert) report.signer = commonName(signerCert.subject);
      const time = cms.signerInfos[0].signedAttrs?.attributes.find(attribute => attribute.type === OID.signingTime)?.values[0];
      if (time instanceof asn1js.UTCTime || time instanceof asn1js.GeneralizedTime) report.signingTime = time.toDate().toISOString();
      report.integrity = ok ? 'valid' : 'invalid';
      const token = cms.signerInfos[0].unsignedAttrs?.attributes.find(attribute => attribute.type === OID.timestampToken)?.values[0];
      if (token) {
        // The token must be validly signed and its imprint must be the hash of this signature value.
        try {
          const tokenData = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: token }).content });
          const content = tokenData.encapContentInfo.eContent!;
          // eContent may be a constructed OCTET STRING: join its chunks.
          const chunks: Uint8Array[] = content.idBlock.isConstructed ? (content.valueBlock.value as asn1js.OctetString[]).map(part => part.valueBlock.valueHexView) : [content.valueBlock.valueHexView];
          const tstBytes = new Uint8Array(chunks.reduce((total, part) => total + part.length, 0)); let at = 0; for (const part of chunks) { tstBytes.set(part, at); at += part.length; }
          const tst = new pkijs.TSTInfo({ schema: asn1js.fromBER(tstBytes.buffer).result });
          if (tokenData.encapContentInfo.eContentType !== OID.tstInfo) throw new Error('Not a timestamp token.');
          // pkijs's TSTInfo shortcut rejects chunked content; verify the token's signature over the exact TSTInfo bytes.
          tokenData.encapContentInfo.eContentType = OID.data; delete (tokenData.encapContentInfo as { eContent?: unknown }).eContent;
          const expected = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', cms.signerInfos[0].signature.valueBlock.valueHexView.slice()));
          const actual = tst.messageImprint.hashedMessage.valueBlock.valueHexView;
          const imprintOk = actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
          const tokenOk = await tokenData.verify({ signer: 0, data: tstBytes.buffer, checkChain: false }).catch(() => false);
          report.timestamp = tst.genTime.toISOString(); report.timestampValid = !!(imprintOk && tokenOk);
        } catch { report.timestampValid = false; }
      }
      if (options.crls?.length && signerCert) {
        // A CRL counts only if it is from the signer's issuer and its own signature checks out.
        const pool = [...(options.trusted ?? []), ...(options.extraCertificates ?? []), ...(cms.certificates ?? []).filter((cert): cert is pkijs.Certificate => cert instanceof pkijs.Certificate)];
        const issuer = pool.find(cert => cert.subject.isEqual(signerCert.issuer));
        const crl = issuer ? options.crls.find(item => item.issuer.isEqual(signerCert.issuer)) : undefined;
        if (!issuer || !crl) { report.revocation = 'not-checked'; report.revocationDetail = "No revocation list from the signer's issuer was supplied."; }
        else if (!(await crl.verify({ issuerCertificate: issuer }).catch(() => false))) { report.revocation = 'not-checked'; report.revocationDetail = 'The supplied revocation list is not validly signed by the issuer.'; }
        else {
          const entry = crl.revokedCertificates?.find(item => item.userCertificate.isEqual(signerCert.serialNumber));
          if (!entry) { report.revocation = 'good'; report.revocationDetail = `Not revoked according to the list issued ${crl.thisUpdate.value.toISOString().slice(0, 10)}.`; }
          else {
            report.revocation = 'revoked';
            const revokedAt = entry.revocationDate.value, signedAt = report.timestamp && report.timestampValid ? new Date(report.timestamp) : undefined;
            report.revocationDetail = signedAt && revokedAt > signedAt
              ? `Certificate revoked ${revokedAt.toISOString().slice(0, 10)}, after the trusted timestamp; the signature was made while it was valid.`
              : `Certificate revoked ${revokedAt.toISOString().slice(0, 10)}.`;
          }
        }
      }
      // OCSP: embedded responses first, then a live query when a fetcher is given and no CRL decided it.
      if (signerCert && report.revocation !== 'good' && report.revocation !== 'revoked' && (options.ocspResponses?.length || options.ocsp)) {
        const pool = [...(options.trusted ?? []), ...(options.extraCertificates ?? []), ...(cms.certificates ?? []).filter((cert): cert is pkijs.Certificate => cert instanceof pkijs.Certificate)];
        const issuer = pool.find(cert => cert.subject.isEqual(signerCert.issuer) && cert !== signerCert);
        if (issuer) {
          let decided: { status: 'good' | 'revoked' | 'unknown'; detail: string } | undefined, raw: Uint8Array | undefined;
          for (const candidate of options.ocspResponses ?? []) { decided = await ocspStatus(candidate, signerCert, issuer, options.trusted ?? []); if (decided) { raw = candidate; break; } }
          const url = ocspUrl(signerCert);
          if (!decided && options.ocsp && url) {
            const request = new pkijs.OCSPRequest();
            await request.createForCertificate(signerCert, { hashAlgorithm: 'SHA-256', issuerCertificate: issuer });
            try { raw = await options.ocsp(url, new Uint8Array(request.toSchema(true).toBER(false))); decided = await ocspStatus(raw, signerCert, issuer, options.trusted ?? []); }
            catch (error) { report.revocation = 'not-checked'; report.revocationDetail = `OCSP check failed: ${error instanceof Error ? error.message : String(error)}`; }
            if (!decided && raw && !report.revocationDetail?.startsWith('OCSP check failed')) { report.revocation = 'not-checked'; report.revocationDetail = 'The OCSP response could not be authenticated for this certificate.'; }
          }
          if (decided && decided.status !== 'unknown') { report.revocation = decided.status; report.revocationSource = 'ocsp'; report.revocationDetail = decided.detail; report.ocspResponse = raw; }
          else if (decided) { report.revocation = 'not-checked'; report.revocationDetail = decided.detail; }
        }
      }
      if (report.revocation && report.revocation !== 'not-checked' && !report.revocationSource) report.revocationSource = 'crl';
      const reference = sig.lookupMaybe(PDFName.of('Reference'), PDFArray)?.asArray().map(item => pdf.context.lookup(item)).find((item): item is PDFDict => item instanceof PDFDict && String(item.lookup(PDFName.of('TransformMethod'))) === '/DocMDP');
      const p = reference?.lookupMaybe(PDFName.of('TransformParams'), PDFDict)?.lookupMaybe(PDFName.of('P'), PDFNumber)?.asNumber();
      if (reference) report.certification = (p === 1 || p === 3 ? p : 2) as 1 | 2 | 3;
      if (options.trusted?.length && signerCert) {
        // Chain from the signer to one of the caller's trusted certificates, at signing time. Revocation is not checked.
        const engine = new pkijs.CertificateChainValidationEngine({ trustedCerts: options.trusted, certs: [...(cms.certificates ?? []).filter((cert): cert is pkijs.Certificate => cert instanceof pkijs.Certificate), ...(options.extraCertificates ?? [])], checkDate: options.at ?? (report.signingTime ? new Date(report.signingTime) : new Date()) });
        const chain = await engine.verify();
        report.trust = chain.result ? 'trusted' : 'untrusted';
        report.trustDetail = chain.result ? 'Certificate chains to a trusted certificate (revocation not checked).' : `Not trusted: ${chain.resultMessage || 'no chain to a trusted certificate'}.`;
      }
      report.detail = !ok ? 'The document was changed after it was signed, or the signature is damaged.'
        : report.coversWholeFile ? 'Signed content is unchanged. The signer certificate was not checked against trusted roots.'
        : 'Signed revision is intact, but the file was changed or extended after signing.';
    } catch (error) {
      report.detail = `Signature could not be verified: ${error instanceof Error ? error.message : String(error)}`;
    }
    reports.push(report);
  }
  return reports;
}
