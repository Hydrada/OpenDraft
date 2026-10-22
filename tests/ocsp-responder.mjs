import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Starts OpenSSL's OCSP responder for the test CA on 127.0.0.1:4199 (the URL inside the test certificates). */
export async function startTestOcspResponder() {
  // openssl appends to its index file's attribute sibling; work on a copy outside the repository.
  const dir = await mkdtemp(path.join(tmpdir(), 'opendraft-ocsp-'));
  for (const file of ['test-ca-index.txt', 'test-ca.pem', 'test-ca.key']) await copyFile(path.join('tests', 'fixtures', file), path.join(dir, file));
  const candidates = [process.env.OPENSSL_BIN, 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];
  const command = candidates.find(value => value && existsSync(value)) ?? 'openssl';
  const child = spawn(command, ['ocsp', '-index', 'test-ca-index.txt', '-port', '4199', '-rsigner', 'test-ca.pem', '-rkey', 'test-ca.key', '-CA', 'test-ca.pem', '-ignore_err'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OCSP responder did not start')), 10_000);
    // openssl prints this once listening; probing the port instead would make it exit on the empty connection.
    let output = '';
    const watch = chunk => { output += chunk; if (output.includes('waiting for OCSP client connections')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', watch); child.stderr.on('data', watch);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`openssl ocsp exited (${code})`)); });
  });
  // openssl binds IPv6 only on Windows and IPv4 only on some Linux hosts; try [::1] first, then 127.0.0.1,
  // and remember whichever answered (a real request, never an empty probe that would stop openssl).
  let loopback;
  const fetchOcsp = async (url, request) => {
    for (const host of loopback ? [loopback] : ['[::1]', '127.0.0.1']) {
      try {
        const response = await fetch(url.replace('//127.0.0.1:', `//${host}:`), { method: 'POST', headers: { 'Content-Type': 'application/ocsp-request' }, body: request });
        loopback = host; return new Uint8Array(await response.arrayBuffer());
      } catch (error) { if (loopback) throw error; }
    }
    throw new Error('OCSP responder unreachable on [::1] and 127.0.0.1');
  };
  return { fetchOcsp, loopback: () => loopback, stop: () => child.kill() };
}
