import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { startHost } = createRequire(import.meta.url)('../desktop/host.cjs');

test('desktop print endpoint accepts only PDFs from the app origin', async t => {
  const printed = [];
  const host = await startHost('apps/opendraft/dist', 0, [], { onPrint: async bytes => { printed.push(bytes.length); } });
  t.after(() => host.close());
  const post = (body, headers) => fetch(host.origin + '/__print', { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers }, body });
  const pdf = Buffer.from('%PDF-1.7\n% test\n');
  assert.equal((await post(pdf, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(pdf, {})).status, 403); // no Origin: not a page of this app
  assert.equal((await post(Buffer.from('not a pdf'), { Origin: host.origin })).status, 400);
  assert.equal((await post(pdf, { Origin: host.origin, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(pdf, { Origin: host.origin })).status, 202);
  assert.deepEqual(printed, [pdf.length]);
  assert.deepEqual(await (await fetch(host.origin + '/__desktop')).json(), { vectorPrint: true });
  const plain = await startHost('apps/opendraft/dist', 0, []);
  t.after(() => plain.close());
  assert.equal((await fetch(plain.origin + '/__print', { method: 'POST', headers: { 'Content-Type': 'application/pdf', Origin: plain.origin }, body: pdf })).status, 405);
});
