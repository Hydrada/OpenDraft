import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/** Minimal RFC 3161 timestamp authority for tests, signing with the given test identity. */
export function testTsa(identity, genTime = new Date('2026-10-22T12:00:00Z')) {
  let serial = 1;
  return async (query) => {
    const req = new pkijs.TimeStampReq({ schema: asn1js.fromBER(query.slice().buffer).result });
    const tst = new pkijs.TSTInfo({ version: 1, policy: '1.3.6.1.4.1.99999.1', messageImprint: req.messageImprint, serialNumber: new asn1js.Integer({ value: serial++ }), genTime, ordering: false, ...(req.nonce ? { nonce: req.nonce } : {}) });
    const tstDer = tst.toSchema().toBER(false);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', tstDer);
    const signed = new pkijs.SignedData({
      version: 3, encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.9.16.1.4', eContent: new asn1js.OctetString({ valueHex: tstDer }) }),
      signerInfos: [new pkijs.SignerInfo({ version: 1, sid: new pkijs.IssuerAndSerialNumber({ issuer: identity.certificate.issuer, serialNumber: identity.certificate.serialNumber }) })],
      certificates: [identity.certificate],
    });
    signed.signerInfos[0].signedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: [
      new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.9.16.1.4' })] }),
      new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: digest })] }),
    ] });
    await signed.sign(identity.privateKey, 0, 'SHA-256');
    // Real TSAs emit DER, where eContent is a primitive OCTET STRING; pkijs always chunks it, so re-wrap.
    const schema = signed.toSchema(true), encap = schema.valueBlock.value.find(item => item instanceof asn1js.Sequence && item.valueBlock.value[0] instanceof asn1js.ObjectIdentifier && item.valueBlock.value[0].valueBlock.toString() === '1.2.840.113549.1.9.16.1.4');
    encap.valueBlock.value[1] = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [new asn1js.OctetString({ valueHex: tstDer })] });
    const token = new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: schema });
    const response = new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: 0 }), timeStampToken: token });
    return new Uint8Array(response.toSchema().toBER(false));
  };
}
