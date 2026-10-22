type Options = {
  document: () => { name: string; bytes: Uint8Array; pageIndex: number } | undefined;
  download: (bytes: Uint8Array, name: string) => void;
  error: (message: string) => void;
  /** Collaboration session token; timestamps are requested through the self-hosted server. */
  token: () => string | undefined;
};

/**
 * Digital signature panel. Signing uses a PKCS#12 (.p12/.pfx) identity held only in memory for
 * this one operation and writes a signed copy; the open document is never changed. Verification
 * checks that each signature matches the bytes it covers; certificate trust is not evaluated.
 */
export function mountSignatures(container: HTMLElement, options: Options) {
  container.innerHTML = '<h3>Digital signature</h3><p>Sign a copy with your certificate file (.p12 or .pfx), or check the signatures in the open PDF. A digital signature proves the file is unchanged since signing; whether the signer is trusted depends on who issued their certificate: add the certificates you trust to check that. Add revocation lists (.crl) to check whether a signing certificate was revoked.</p>';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Signature status');
  const results = document.createElement('ul'); results.setAttribute('aria-label', 'Signatures in this PDF');
  const label = (text: string, input: HTMLInputElement) => { const row = document.createElement('label'); row.textContent = text; input.setAttribute('aria-label', text); row.append(input); container.append(row); return input; };
  const input = (type: string, value = '') => { const element = document.createElement('input'); element.type = type; element.value = value; return element; };
  const certificate = label('Signing certificate (.p12 or .pfx)', input('file')); certificate.accept = '.p12,.pfx,application/x-pkcs12';
  const password = label('Certificate password', input('password')); password.autocomplete = 'off';
  const reason = label('Signature reason', input('text', 'Approved'));
  const location = label('Signature location', input('text'));
  const visible = label('Show signature box on the current page', input('checkbox')); visible.checked = true;
  const box = label('Signature box (x1,y1;x2,y2 in PDF units)', input('text', '40,40;260,100'));
  const field = label('Sign into existing signature field (name, optional)', input('text'));
  const certifyRow = document.createElement('label'); certifyRow.textContent = 'Certify document (first signature only)';
  const certify = document.createElement('select'); certify.setAttribute('aria-label', 'Certify document');
  for (const [value, text] of [['', 'No - ordinary signature'], ['1', 'Certify: no changes allowed'], ['2', 'Certify: form filling and signing allowed'], ['3', 'Certify: also annotations allowed']]) certify.append(new Option(text, value));
  certifyRow.append(certify); container.append(certifyRow);
  const stamp = label('Add a trusted timestamp (needs sign-in to a collaboration server with a timestamp authority)', input('checkbox'));
  const trusted = label('Trusted certificates for checking (.pem/.cer/.crt, optional)', input('file')); trusted.multiple = true; trusted.accept = '.pem,.cer,.crt,.der';
  const online = label('Check revocation online (OCSP, through the collaboration server)', input('checkbox'));
  const revocations = label('Revocation lists for checking (.crl, optional)', input('file')); revocations.multiple = true; revocations.accept = '.crl,.pem';
  const button = (text: string, run: () => Promise<void>) => {
    const element = document.createElement('button'); element.textContent = text;
    element.onclick = async () => { element.disabled = true; try { await run(); } catch (e) { const message = e instanceof Error ? e.message : String(e); status.textContent = message; options.error(message); } finally { element.disabled = false; } };
    container.append(element);
  };
  const current = () => { const doc = options.document(); if (!doc) throw new Error('Open a PDF first.'); return doc; };

  button('Sign and save copy', async () => {
    const doc = current(), file = certificate.files?.[0];
    if (!file) throw new Error('Choose your certificate file first.');
    if (file.size > 1024 * 1024) throw new Error('Certificate files larger than 1 MB are not supported.');
    status.textContent = 'Reading certificate…';
    const { readPkcs12, signPdf } = await import('./pdf-signature');
    const identity = await readPkcs12(new Uint8Array(await file.arrayBuffer()), password.value);
    password.value = '';
    let visibleRect: [number, number, number, number] | undefined;
    if (visible.checked) {
      const pairs = box.value.split(';').map(pair => pair.split(',').map(Number));
      if (pairs.length !== 2 || pairs.some(pair => pair.length !== 2 || !pair.every(Number.isFinite))) throw new Error('Enter the signature box as x1,y1;x2,y2.');
      visibleRect = [pairs[0][0], pairs[0][1], pairs[1][0], pairs[1][1]];
    }
    status.textContent = `Signing as ${identity.signerName}…`;
    let timestamp: ((query: Uint8Array) => Promise<Uint8Array>) | undefined;
    if (stamp.checked) {
      const token = options.token();
      if (!token) throw new Error('Sign in to a collaboration server first; timestamps are requested through it.');
      timestamp = async query => {
        let binary = ''; for (const byte of query) binary += String.fromCharCode(byte);
        const response = await fetch('/api/timestamp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ request: btoa(binary) }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? 'The timestamp request failed.');
        return Uint8Array.from(atob(data.response), c => c.charCodeAt(0));
      };
    }
    const signed = await signPdf(doc.bytes, identity, { ...(timestamp ? { timestamp } : {}), reason: reason.value, location: location.value, pageIndex: doc.pageIndex, visibleRect, ...(field.value.trim() ? { field: field.value.trim() } : {}), ...(certify.value ? { certify: Number(certify.value) as 1 | 2 | 3 } : {}) });
    options.download(signed, `${doc.name.replace(/\.pdf$/i, '')}-signed.pdf`);
    status.textContent = `Saved a copy signed by ${identity.signerName}. The open document is unchanged; edits made after signing would invalidate the signature.`;
  });
  button('Check signatures in this PDF', async () => {
    const doc = current();
    const { reports } = await check(doc);
    results.replaceChildren(...reports.map(report => {
      const item = document.createElement('li');
      const trust = report.trust === 'trusted' ? ' · TRUSTED' : report.trust === 'untrusted' ? ' · NOT TRUSTED' : '';
      const stamped = report.timestamp ? ` · timestamped ${report.timestamp.replace('T', ' ').slice(0, 19)} UTC${report.timestampValid ? '' : ' (TIMESTAMP INVALID)'}` : '';
      const via = report.revocationSource === 'ocsp' ? ' (OCSP)' : report.revocationSource === 'crl' ? ' (CRL)' : '';
      const revoked = report.revocation === 'revoked' ? ` · REVOKED${via}` : report.revocation === 'good' ? ` · not revoked${via}` : '';
      if (report.kind === 'document-timestamp') { item.textContent = `${report.field}: DOCUMENT TIMESTAMP ${report.integrity === 'valid' ? 'VALID' : 'INVALID'}${report.trust === 'trusted' ? ' · TRUSTED' : report.trust === 'untrusted' ? ' · NOT TRUSTED' : ''} · ${report.timestamp?.replace('T', ' ').slice(0, 19) ?? ''} UTC by ${report.signer}. ${report.detail}`; return item; }
      const certified = report.certification ? ` · certifies the document (level ${report.certification})` : '';
      item.textContent = `${report.field}: ${report.integrity === 'valid' ? 'VALID' : 'INVALID'}${trust}${revoked} · signed by ${report.signer}${report.signingTime ? ` on ${report.signingTime.replace('T', ' ').slice(0, 19)} UTC` : ''}${report.reason ? ` · ${report.reason}` : ''}${stamped}${certified}. ${report.detail}${report.trustDetail ? ` ${report.trustDetail}` : ''}${report.revocationDetail ? ` ${report.revocationDetail}` : ''}`;
      return item;
    }));
    status.textContent = reports.length ? `${reports.filter(report => report.integrity === 'valid').length} of ${reports.length} signature(s) valid.` : 'This PDF has no digital signatures.';
  });
  button('Add long-term validation data and save copy', async () => {
    // Embeds certificate chains and the revocation evidence just gathered, so the copy stays verifiable later.
    const doc = current(), { reports, roots, crls } = await check(doc);
    if (!reports.length) throw new Error('This PDF has no digital signatures.');
    const { embedValidationData } = await import('./pdf-signature');
    const ocsps = reports.flatMap(report => report.ocspResponse ? [report.ocspResponse] : []);
    options.download(await embedValidationData(doc.bytes, { certificates: roots, crls, ocsps }), `${doc.name.replace(/\.pdf$/i, '')}-ltv.pdf`);
    status.textContent = `Saved a copy with long-term validation data (${crls.length} revocation list(s), ${ocsps.length} OCSP response(s)); signatures are unchanged.`;
  });
  button('Add archival document timestamp and save copy', async () => {
    // PAdES-LTA: seals the file and its validation data; re-apply before the TSA certificate expires.
    const doc = current(), token = options.token();
    if (!token) throw new Error('Sign in to a collaboration server with a timestamp authority first.');
    const { addDocumentTimestamp } = await import('./pdf-signature');
    const stamped = await addDocumentTimestamp(doc.bytes, async query => {
      let binary = ''; for (const byte of query) binary += String.fromCharCode(byte);
      const response = await fetch('/api/timestamp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ request: btoa(binary) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'The timestamp request failed.');
      return Uint8Array.from(atob(data.response), c => c.charCodeAt(0));
    });
    options.download(stamped, `${doc.name.replace(/\.pdf$/i, '')}-archived.pdf`);
    status.textContent = 'Saved a copy with an archival document timestamp; earlier signatures are unchanged.';
  });
  async function check(doc: { bytes: Uint8Array }) {
    const { readCertificates, readCrls, verifyPdfSignatures } = await import('./pdf-signature');
    const roots = (await Promise.all(Array.from(trusted.files ?? [], async file => readCertificates(new Uint8Array(await file.arrayBuffer()))))).flat();
    const crls = (await Promise.all(Array.from(revocations.files ?? [], async file => readCrls(new Uint8Array(await file.arrayBuffer()))))).flat();
    let ocsp: ((url: string, request: Uint8Array) => Promise<Uint8Array>) | undefined;
    if (online.checked) {
      const token = options.token();
      if (!token) throw new Error('Sign in to a collaboration server first; online revocation checks go through it.');
      ocsp = async (url, request) => {
        let binary = ''; for (const byte of request) binary += String.fromCharCode(byte);
        const response = await fetch('/api/ocsp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ url, request: btoa(binary) }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? 'The OCSP request failed.');
        return Uint8Array.from(atob(data.response), c => c.charCodeAt(0));
      };
    }
    return { reports: await verifyPdfSignatures(doc.bytes, { trusted: roots, crls, ...(ocsp ? { ocsp } : {}) }), roots, crls };
  }
  container.append(results, status);
}
