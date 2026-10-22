import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCollabServer } from '../server/collab-server.mjs';
import { applyAccepted, diffState, emptyStore, storeState } from '../apps/opendraft/src/collab-sync.ts';

const password = 'correct horse battery';
const mark = (id, extra = {}) => ({ id, pageIndex: 0, kind: 'rectangle', points: [[10, 10], [50, 50]], color: [1, 0, 0], width: 1, opacity: 1, contents: id, author: 'a', status: 'open', locked: false, createdAt: '2026-10-21T00:00:00.000Z', modifiedAt: '2026-10-21T00:00:00.000Z', ...extra });

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'opendraft-collab-'));
  let clock = Date.parse('2026-10-21T12:00:00Z');
  const app = await createCollabServer({ dataDir, now: () => clock });
  await app.addUser('admin', password, { admin: true });
  await app.addUser('alice', password); await app.addUser('bob', password); await app.addUser('val', password);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (token, method, route, body) => {
    const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const login = async user => (await call(undefined, 'POST', '/session', { username: user, password })).body.token;
  return { app, dataDir, base, call, login, advance: ms => { clock += ms; } };
}

test('concurrent edits to different items merge; same-item edits conflict; retries are idempotent', async t => {
  const { call, login } = await setup(t);
  const alice = await login('alice'), bob = await login('bob'), val = await login('val');
  const project = (await call(alice, 'POST', '/projects', { name: 'A101', documentSha256: 'a'.repeat(64), pageCount: 2 })).body;
  assert.equal(project.role, 'owner');
  for (const [user, role] of [['bob', 'editor'], ['val', 'viewer']]) assert.equal((await call(alice, 'PUT', `/projects/${project.id}/members`, { username: user, role })).status, 200);
  assert.equal((await call(bob, 'PUT', `/projects/${project.id}/members`, { username: 'bob', role: 'owner' })).status, 403);

  const first = await call(alice, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-alice-1', ops: [{ c: 'markups', id: 'm1', base: 0, item: mark('m1') }] });
  assert.equal(first.body.status, 'applied');
  // Bob edits a different item from the same base: merges.
  assert.equal((await call(bob, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-bob-1', ops: [{ c: 'markups', id: 'm2', base: 0, item: mark('m2') }] })).body.version, 2);
  // Both edit m1 from v1: the second is a conflict carrying the server entry.
  assert.equal((await call(alice, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-alice-2', ops: [{ c: 'markups', id: 'm1', base: 1, item: mark('m1', { contents: 'alice' }) }] })).status, 200);
  const conflict = await call(bob, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-bob-2', ops: [{ c: 'markups', id: 'm1', base: 1, item: mark('m1', { contents: 'bob' }) }] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.conflicts[0].server.item.contents, 'alice');
  // Retrying an applied batch (lost response) never applies twice.
  const retry = await call(alice, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-alice-2', ops: [{ c: 'markups', id: 'm1', base: 1, item: mark('m1', { contents: 'alice' }) }] });
  assert.equal(retry.body.duplicate, true); assert.equal(retry.body.version, 3);
  assert.equal((await call(val, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-val-1', ops: [{ c: 'markups', id: 'v', base: 0, item: mark('v') }] })).status, 403);
  // Whole-state validation with the app's own validators rejects invalid shared state atomically.
  const invalid = await call(alice, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-alice-3', ops: [{ c: 'markups', id: 'm9', base: 0, item: mark('m9', { pageIndex: 7 }) }] });
  assert.equal(invalid.status, 422);
  const snapshot = (await call(val, 'GET', `/projects/${project.id}`)).body;
  assert.equal(snapshot.version, 3);
  assert.deepEqual(storeState(snapshot.store).markups.map(item => [item.id, item.contents]), [['m1', 'alice'], ['m2', 'm2']]);
  const changes = (await call(val, 'GET', `/projects/${project.id}/changes?since=1`)).body;
  assert.deepEqual(changes.batches.map(batch => batch.version), [2, 3]);
  // A client shadow built from changes converges with the snapshot.
  let shadow = emptyStore();
  for (const batch of (await call(val, 'GET', `/projects/${project.id}/changes?since=0`)).body.batches) shadow = applyAccepted(shadow, batch.changes);
  assert.deepEqual(shadow, snapshot.store);
  assert.deepEqual(diffState(shadow, storeState(shadow)), []);
  assert.equal((await call(await login('admin'), 'GET', `/projects/${project.id}`)).status, 200);
  assert.equal((await call('forged', 'GET', `/projects/${project.id}`)).status, 401);
});

test('live events, presence, audit tamper detection, backup and restore', async t => {
  const { call, login, dataDir, base, app } = await setup(t);
  const alice = await login('alice');
  const project = (await call(alice, 'POST', '/projects', { name: 'S', documentSha256: 'b'.repeat(64), pageCount: 1 })).body;
  const controller = new AbortController();
  const stream = await fetch(`${base}/projects/${project.id}/events`, { headers: { Authorization: `Bearer ${alice}` }, signal: controller.signal });
  const reader = stream.body.getReader(), decoder = new TextDecoder(); let received = '';
  const until = async text => { while (!received.includes(text)) received += decoder.decode((await reader.read()).value); };
  await until('event: hello');
  await call(alice, 'POST', `/projects/${project.id}/presence`, { page: 1, client: 'tab-1' });
  await until('event: presence');
  await call(alice, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-live-1', ops: [{ c: 'markups', id: 'm1', base: 0, item: mark('m1') }] });
  await until('"batchId":"batch-live-1"');
  controller.abort();

  const backup = (await call(alice, 'POST', `/projects/${project.id}/backups`)).body;
  await call(alice, 'POST', `/projects/${project.id}/batches`, { batchId: 'batch-live-2', ops: [{ c: 'markups', id: 'm1', base: 1, item: null }] });
  assert.equal(storeState((await call(alice, 'GET', `/projects/${project.id}`)).body.store).markups.length, 0);
  const restored = (await call(alice, 'POST', `/projects/${project.id}/restore`, { name: backup.name })).body;
  assert.equal(restored.version, 3);
  const after = (await call(alice, 'GET', `/projects/${project.id}`)).body;
  assert.deepEqual(storeState(after.store).markups.map(item => item.id), ['m1']);
  assert.equal((await call(alice, 'GET', `/projects/${project.id}/changes?since=1`)).status, 410);

  const audit = (await call(alice, 'GET', `/projects/${project.id}/audit`)).body;
  assert.equal(audit.verification.valid, true);
  assert.deepEqual(audit.records.map(record => record.action), ['project.create', 'batch.apply', 'backup.create', 'batch.apply', 'backup.restore']);
  const file = path.join(dataDir, 'audit', `${project.id}.jsonl`), lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  const tampered = JSON.parse(lines[1]); tampered.user = 'mallory'; lines[1] = JSON.stringify(tampered);
  await writeFile(file, lines.join('\n') + '\n');
  assert.deepEqual(await app.verifyAudit(project.id), { valid: false, records: 5, brokenAt: 1 });
});

test('sign-in is rate limited and passwords are never stored in clear text', async t => {
  const { call, dataDir, advance } = await setup(t);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await call(undefined, 'POST', '/session', { username: 'alice', password: 'wrong password!!' })).status, 401);
  assert.equal((await call(undefined, 'POST', '/session', { username: 'alice', password })).status, 429);
  advance(61_000);
  assert.equal((await call(undefined, 'POST', '/session', { username: 'alice', password })).status, 200);
  const stored = await readFile(path.join(dataDir, 'users.json'), 'utf8');
  assert.equal(stored.includes(password), false);
  assert.equal((await call(undefined, 'POST', '/session', { username: 'nobody', password })).status, 401);
});

test('timestamp requests are relayed only to the configured authority and only for signed-in users', async t => {
  const { createServer } = await import('node:http');
  const { readPkcs12, signPdf, verifyPdfSignatures } = await import('../apps/opendraft/src/pdf-signature.ts');
  const { testTsa } = await import('./tsa-fixture.mjs');
  const { PDFDocument } = await import('pdf-lib');
  const identity = await readPkcs12(new Uint8Array(await readFile('tests/fixtures/test-signer.p12')), 'opendraft-test'), tsa = testTsa(identity);
  const received = [];
  const authority = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push(request.headers['content-type']);
    response.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }); response.end(Buffer.from(await tsa(new Uint8Array(Buffer.concat(chunks)))));
  });
  await new Promise(resolve => authority.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'opendraft-tsa-'));
  const app = await createCollabServer({ dataDir, tsa: { url: `http://127.0.0.1:${authority.address().port}/tsa` } });
  await app.addUser('alice', password);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); authority.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const token = (await (await fetch(base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password }) })).json()).token;
  const relay = async (query, auth = token) => fetch(base + '/timestamp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ request: Buffer.from(query).toString('base64') }) });
  assert.equal((await (await fetch(base + '/timestamp', { headers: { Authorization: `Bearer ${token}` } })).json()).available, true);
  assert.equal((await relay(new Uint8Array([0x30, 0]), null)).status, 401);
  assert.equal((await relay(new Uint8Array([1, 2, 3]))).status, 400);
  const pdf = await PDFDocument.create(); pdf.addPage();
  const signed = await signPdf(await pdf.save(), identity, { timestamp: async query => { const response = await relay(query); assert.equal(response.status, 200); return new Uint8Array(Buffer.from((await response.json()).response, 'base64')); } });
  const [report] = await verifyPdfSignatures(signed);
  assert.equal(report.timestampValid, true);
  assert.deepEqual(received, ['application/timestamp-query']);
});

test('team tool set: administrators publish a validated preset library that every signed-in user can load', async t => {
  const { call, login } = await setup(t);
  const { presetFromMarkup, serializePresetLibrary, parsePresetLibrary } = await import('../apps/opendraft/src/markup-presets.ts');
  const preset = presetFromMarkup({ kind: 'cloud', color: [0.9, 0.1, 0.1], width: 3, opacity: 1, contents: 'RFI' }, 'RFI cloud', 'team-rfi');
  const library = serializePresetLibrary([preset]);
  const admin = await login('admin'), bob = await login('bob');
  assert.deepEqual(parsePresetLibrary((await call(bob, 'GET', '/toolset')).body.library), []);
  assert.equal((await call(bob, 'PUT', '/toolset', { library })).status, 403);
  assert.equal((await call(admin, 'PUT', '/toolset', { library: '{"not":"a library"}' })).status, 400);
  assert.equal((await call(undefined, 'GET', '/toolset')).status, 401);
  const published = await call(admin, 'PUT', '/toolset', { library });
  assert.equal(published.status, 200); assert.equal(published.body.updatedBy, 'admin');
  const loaded = await call(bob, 'GET', '/toolset');
  assert.deepEqual(parsePresetLibrary(loaded.body.library).map(p => [p.id, p.name, p.kind]), [['team-rfi', 'RFI cloud', 'cloud']]);
});

test('OCSP relay forwards only to allow-listed responders and returns authentic status', async t => {
  const { startTestOcspResponder } = await import('./ocsp-responder.mjs');
  const { readPkcs12, readCertificates, signPdf, verifyPdfSignatures } = await import('../apps/opendraft/src/pdf-signature.ts');
  const { PDFDocument } = await import('pdf-lib');
  const responder = await startTestOcspResponder();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'opendraft-ocsp-relay-'));
  // The test responder listens on [::1] (Windows) or 127.0.0.1 (some Linux); allow-list both and use whichever answers.
  const app = await createCollabServer({ dataDir, ocspHosts: ['[::1]:4199', '127.0.0.1:4199'] });
  await app.addUser('alice', password);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { responder.stop(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const token = (await (await fetch(base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password }) })).json()).token;
  const relay = (url, request) => fetch(base + '/ocsp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ url, request: Buffer.from(request).toString('base64') }) });
  assert.equal((await relay('http://169.254.169.254/latest', new Uint8Array([0x30, 0]))).status, 403);
  assert.equal((await relay('file:///etc/passwd', new Uint8Array([0x30, 0]))).status, 400);
  const identity = await readPkcs12(new Uint8Array(await readFile('tests/fixtures/test-ca-signer-revoked.p12')), 'opendraft-test');
  const pdf = await PDFDocument.create(); pdf.addPage();
  const [report] = await verifyPdfSignatures(await signPdf(await pdf.save(), identity), {
    trusted: readCertificates(new Uint8Array(await readFile('tests/fixtures/test-ca.pem'))),
    ocsp: async (url, request) => {
      await responder.fetchOcsp(url, request); // finds which loopback address the responder is on
      const response = await relay(url.replace('//127.0.0.1:', `//${responder.loopback()}:`), request); assert.equal(response.status, 200); return new Uint8Array(Buffer.from((await response.json()).response, 'base64')); },
  });
  assert.deepEqual([report.revocation, report.revocationSource], ['revoked', 'ocsp']);
});
