import test from 'node:test';
import assert from 'node:assert/strict';
import { punchListCsv } from '../apps/opendraft/src/markup-reports.ts';

const at = (m) => `2026-10-2${m}T10:00:00.000Z`;
const mark = (id, pageIndex, y, status, contents, comments) => ({ id, pageIndex, kind: 'cloud', points: [[100, y], [200, y + 50]], color: [1, 0, 0], width: 2, opacity: 1, contents, author: 'Inspector', status, locked: false, createdAt: at(0), modifiedAt: at(0), ...(comments ? { comments } : {}) });

test('punch list numbers open items by page then top-to-bottom and shows the latest reply', () => {
  const csv = punchListCsv('site.pdf', 2, [
    mark('low', 0, 100, 'open', 'Patch wall'), mark('high', 0, 500, 'open', 'Missing fire damper', [
      { id: 'c1', author: 'GC', contents: 'Ordered', createdAt: at(1), modifiedAt: at(1) }, { id: 'c2', author: 'GC', contents: 'Installed, ready', createdAt: at(2), modifiedAt: at(2) }]),
    mark('p2', 1, 300, 'open', '=cmd()'), mark('done', 0, 300, 'accepted', 'Closed item'),
  ], { sheetNumbers: new Map([[0, 'M201']]) }).trim().split('\r\n');
  assert.equal(csv.length, 4);
  assert.match(csv[1], /^"P-001","open","1","M201","cloud","Missing fire damper","Inspector",.*"2","GC: Installed, ready","high"$/);
  assert.match(csv[2], /^"P-002","open","1","M201","cloud","Patch wall"/);
  assert.match(csv[3], /^"P-003","open","2","","cloud","'=cmd\(\)"/);
  assert.equal(punchListCsv('site.pdf', 2, [mark('done', 0, 300, 'accepted', 'x')], { includeClosed: true }).trim().split('\r\n').length, 2);
});
