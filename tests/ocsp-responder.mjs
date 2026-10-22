import { spawn } from 'node:child_process';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Starts OpenSSL's OCSP responder for the test CA on 127.0.0.1:4199 (the URL inside the test certificates). */
export async function startTestOcspResponder() {
  // openssl appends to its index file's attribute sibling; work on a copy outside the repository.
  const dir = await mkdtemp(path.join(tmpdir(), 'opendraft-ocsp-'));
  for (const file of ['test-ca-index.txt', 'test-ca.pem', 'test-ca.key']) await copyFile(path.join('tests', 'fixtures', file), path.join(dir, file));
  const child = spawn('openssl', ['ocsp', '-index', 'test-ca-index.txt', '-port', '4199', '-rsigner', 'test-ca.pem', '-rkey', 'test-ca.key', '-CA', 'test-ca.pem', '-ignore_err'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OCSP responder did not start')), 10_000);
    // openssl prints this once listening; probing the port instead would make it exit on the empty connection.
    let output = '';
    const watch = chunk => { output += chunk; if (output.includes('waiting for OCSP client connections')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', watch); child.stderr.on('data', watch);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`openssl ocsp exited (${code})`)); });
  });
  // openssl binds IPv6 [::] only (IPv4 loopback is not accepted on Windows); reach the URL from the certificate over [::1].
  const fetchOcsp = async (url, request) => { const response = await fetch(url.replace('//127.0.0.1:', '//[::1]:'), { method: 'POST', headers: { 'Content-Type': 'application/ocsp-request' }, body: request }); return new Uint8Array(await response.arrayBuffer()); };
  return { fetchOcsp, stop: () => child.kill() };
}
