import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { proposeSheetIndexRules, validateSheetProposals, applySheetBookmarks, sheetIndexCsv, validateAccepted } from '../apps/opendraft/src/ai-sheet-index.ts';
import { createCollabServer } from '../server/collab-server.mjs';

test('CPU rules engine proposes numbers and titles with confidence and evidence', () => {
  const proposals = proposeSheetIndexRules([
    { pageIndex: 0, text: 'GENERAL NOTES\nSee details\nSHEET A-101 FIRST FLOOR PLAN' },
    { pageIndex: 1, text: 'Valve schedule B202' },
    { pageIndex: 2, text: 'no identifiers here' },
    { pageIndex: 3, text: 'Detail C1 and C2' },
  ]);
  assert.deepEqual(proposals.map(item => [item.pageIndex, item.number, item.title, item.confidence]), [
    [0, 'A-101', 'FIRST FLOOR PLAN', 'high'], [1, 'B202', 'Valve schedule', 'medium'], [3, 'C1', 'Detail and C2', 'low'],
  ]);
  assert.ok(proposals.every(item => item.source === 'rules' && item.evidence));
});

test('CPU rules engine takes the title from the title-block line next to a standalone sheet number', () => {
  const proposals = proposeSheetIndexRules([
    { pageIndex: 0, text: 'OFFICE 101\nLOBBY\n60\'-0"\nA101\nFIRST FLOOR PLAN\nSCALE: 1/4" = 1\'-0"' },
    { pageIndex: 1, text: 'NOTES\nMECHANICAL PLAN\nM201\nSCALE: NTS' },
    { pageIndex: 2, text: 'S-301\nDATE: 2026-01-01' },
  ]);
  assert.deepEqual(proposals.map(item => [item.number, item.title, item.confidence]), [
    ['A101', 'FIRST FLOOR PLAN', 'high'], ['M201', 'MECHANICAL PLAN', 'high'], ['S-301', '', 'high'],
  ]);
  assert.equal(proposals[0].evidence, 'A101 / FIRST FLOOR PLAN');
});

test('untrusted engine output is schema-validated and bounded', () => {
  const rows = validateSheetProposals({ sheets: [
    { pageIndex: 0, number: ' A1\u0007 ', title: 'x'.repeat(500), confidence: 'certain' },
    { pageIndex: 0, number: 'dup', title: '' }, { pageIndex: 9, number: 'out', title: '' }, { pageIndex: 1, number: '', title: 'empty' }, 'junk', null,
  ] }, 2, 'model');
  assert.deepEqual(rows.map(row => [row.pageIndex, row.number, row.title.length, row.confidence]), [[0, 'A1', 200, 'low']]);
  assert.throws(() => validateSheetProposals({ sheet: [] }, 2, 'model'), /sheets/);
  assert.throws(() => validateAccepted([{ pageIndex: 0, number: 'A', title: '' }, { pageIndex: 0, number: 'B', title: '' }], 2), /unique page/);
  assert.equal(sheetIndexCsv([{ pageIndex: 0, number: '=cmd', title: '+x' }]), '"Page","Sheet number","Sheet title"\r\n"1","\'=cmd","\'+x"\r\n');
});

test('accepted sheets become reviewed bookmarks appended after an existing outline', async () => {
  const source = await PDFDocument.create(); source.addPage(); source.addPage(); source.addPage();
  const plain = await applySheetBookmarks(await source.save(), [{ pageIndex: 2, number: 'S1', title: 'Structure' }, { pageIndex: 0, number: 'A1', title: '' }]);
  const nested = await applySheetBookmarks(plain, [{ pageIndex: 1, number: 'M1', title: 'Mechanical' }]);
  const doc = await pdfjs.getDocument({ data: nested.slice() }).promise;
  const outline = await doc.getOutline();
  assert.deepEqual(outline.map(item => [item.title, item.items.map(child => child.title)]), [['Sheet index (reviewed)', ['A1', 'S1 — Structure']], ['Sheet index (reviewed)', ['M1 — Mechanical']]]);
  const dest = outline[0].items[1].dest;
  assert.equal(await doc.getPageIndex(dest[0]), 2);
  await doc.cleanup();
  await assert.rejects(applySheetBookmarks(await source.save(), []), /at least one/);
});

test('optional model engine is off by default, authenticated, and its output is validated', async t => {
  let reply = { sheets: [{ pageIndex: 0, number: 'E-301', title: 'Lighting', confidence: 'high', evidence: 'E-301 Lighting' }, { pageIndex: 99, number: 'X', title: 'injected' }] };
  const fake = http.createServer((request, response) => { let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { const parsed = JSON.parse(body); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ model: parsed.model, response: typeof reply === 'string' ? reply : JSON.stringify(reply) })); }); });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const dirs = [await mkdtemp(path.join(tmpdir(), 'od-ai-')), await mkdtemp(path.join(tmpdir(), 'od-ai-off-'))];
  const on = await createCollabServer({ dataDir: dirs[0], ai: { url: `http://127.0.0.1:${fake.address().port}`, model: 'test-model' } });
  const off = await createCollabServer({ dataDir: dirs[1] });
  for (const app of [on, off]) { await app.addUser('alice', 'correct horse battery'); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  t.after(async () => { await on.close(); await off.close(); fake.close(); for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const api = async (app, method, route, body, token) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const tokenOn = (await api(on, 'POST', '/session', { username: 'alice', password: 'correct horse battery' })).body.token;
  const tokenOff = (await api(off, 'POST', '/session', { username: 'alice', password: 'correct horse battery' })).body.token;
  const request = { pageCount: 2, pages: [{ pageIndex: 0, text: 'E-301 Lighting' }, { pageIndex: 1, text: '' }] };
  assert.equal((await api(on, 'POST', '/ai/sheet-index', request)).status, 401);
  assert.deepEqual((await api(off, 'GET', '/ai/status', undefined, tokenOff)).body, { available: false, model: null });
  assert.equal((await api(off, 'POST', '/ai/sheet-index', request, tokenOff)).status, 404);
  assert.deepEqual((await api(on, 'GET', '/ai/status', undefined, tokenOn)).body, { available: true, model: 'test-model' });
  const result = await api(on, 'POST', '/ai/sheet-index', request, tokenOn);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.sheets.map(row => [row.pageIndex, row.number, row.source]), [[0, 'E-301', 'model']]);
  reply = 'not json';
  assert.equal((await api(on, 'POST', '/ai/sheet-index', request, tokenOn)).status, 502);
  reply = { wrong: true };
  assert.equal((await api(on, 'POST', '/ai/sheet-index', request, tokenOn)).status, 502);
});
