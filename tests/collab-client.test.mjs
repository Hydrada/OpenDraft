import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCollabServer } from '../server/collab-server.mjs';
import { CollabSession } from '../apps/opendraft/src/collab-client.ts';

const password = 'correct horse battery';
const mark = (id, contents = id) => ({ id, pageIndex: 0, kind: 'rectangle', points: [[10, 10], [50, 50]], color: [1, 0, 0], width: 1, opacity: 1, contents, author: 'a', status: 'open', locked: false, createdAt: '2026-10-21T00:00:00.000Z', modifiedAt: '2026-10-21T00:00:00.000Z' });
const empty = () => ({ markups: [], layers: [], takeoff: { scales: [], records: [] } });
const memoryStorage = () => { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };
const waitFor = async (check, label) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail(`Timed out: ${label}`); };

function client(base, storage = memoryStorage()) {
  const host = { state: empty(), local: () => host.state, install: async state => { host.state = structuredClone(state); return true; }, changed: () => {} };
  const network = { offline: false };
  const session = new CollabSession(host, base, (...args) => network.offline ? Promise.reject(new TypeError('offline')) : fetch(...args), storage);
  const edit = async mutate => { host.state = structuredClone(host.state); mutate(host.state); await session.localChanged(); };
  return { host, session, network, storage, edit };
}

test('two clients converge live, queue offline work, surface conflicts and resolve explicitly', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'opendraft-collab-client-'));
  const app = await createCollabServer({ dataDir });
  await app.addUser('alice', password); await app.addUser('bob', password);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const a = client(base), b = client(base);
  t.after(async () => { a.session.leave(); b.session.leave(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  await a.session.signIn('alice', password); await b.session.signIn('bob', password);
  const sha = 'c'.repeat(64);
  const project = await a.session.createProject('Site', sha, 1);
  await a.session.join(project.id, sha, 1);
  await a.session.setMember('bob', 'editor');
  await assert.rejects(b.session.join(project.id, 'd'.repeat(64), 1), /different PDF/);
  await b.session.join(project.id, sha, 1);

  await a.edit(state => state.markups.push(mark('m1')));
  await waitFor(() => b.host.state.markups.length === 1, 'bob receives m1');
  await b.edit(state => state.markups.push(mark('m2')));
  await waitFor(() => a.host.state.markups.length === 2, 'alice receives m2');
  assert.deepEqual(a.host.state, b.host.state);

  // Bob goes offline and keeps editing; work is queued and persisted.
  b.network.offline = true;
  await Promise.race([b.edit(state => { state.markups[1] = mark('m2', 'bob offline'); }), new Promise(resolve => setTimeout(resolve, 100))]);
  assert.equal(b.session.status, 'offline');
  assert.ok([...b.storage.map.keys()].some(key => key.includes(project.id)));
  // Meanwhile Alice edits m1 and m2.
  await a.edit(state => { state.markups[0] = mark('m1', 'alice'); state.markups[1] = mark('m2', 'alice'); });
  b.network.offline = false;
  await waitFor(() => b.session.status === 'conflict', 'bob sees conflict after reconnect');
  assert.deepEqual(b.session.conflicts.map(item => [item.c, item.id, item.mine.contents, item.server.item.contents]), [['markups', 'm2', 'bob offline', 'alice']]);
  assert.equal(b.host.state.markups[0].contents, 'alice');
  assert.equal(b.host.state.markups[1].contents, 'alice');

  await b.session.resolve('markups', 'm2', 'mine');
  await waitFor(() => a.host.state.markups[1]?.contents === 'bob offline', 'alice receives resolved m2');
  assert.equal(b.session.conflicts.length, 0);
  assert.deepEqual(a.host.state, b.host.state);
});

test('unsent work survives a reload and is rebased on rejoin', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'opendraft-collab-reload-'));
  const app = await createCollabServer({ dataDir });
  await app.addUser('alice', password);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, storage = memoryStorage(), sha = 'e'.repeat(64);
  const first = client(base, storage);
  t.after(async () => { first.session.leave(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await first.session.signIn('alice', password);
  const project = await first.session.createProject('Reload', sha, 1);
  await first.session.join(project.id, sha, 1);
  first.network.offline = true;
  await Promise.race([first.edit(state => state.markups.push(mark('offline'))), new Promise(resolve => setTimeout(resolve, 100))]);
  first.session.leave();
  const second = client(base, storage);
  t.after(() => second.session.leave());
  await second.session.signIn('alice', password);
  await second.session.join(project.id, sha, 1);
  await waitFor(() => second.session.status === 'synced', 'second session synced');
  assert.deepEqual(second.host.state.markups.map(item => item.id), ['offline']);
  assert.equal([...storage.map.keys()].length, 0);
});
