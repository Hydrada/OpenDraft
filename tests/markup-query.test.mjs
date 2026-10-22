import test from 'node:test';
import assert from 'node:assert/strict';
import { queryMarkups } from '../apps/opendraft/src/markup-query.ts';

const time = '2026-10-21T12:00:00.000Z';
const mark = (id, extra = {}) => ({ id, pageIndex: 0, kind: 'rectangle', points: [[1, 1], [20, 20]], color: [1, 0, 0], width: 1, opacity: 1, contents: 'Review dimension', author: 'Reviewer', status: 'open', locked: false, createdAt: time, modifiedAt: time, ...extra });
const layers = [{ id: 'review', name: 'Café review 2', visible: false, locked: true }, { id: 'other', name: 'Review 10', visible: true, locked: false }];
const ids = result => result.map(mark => mark.id);

test('combined filters query metadata and effective locks without changing source order or data', () => {
  const marks = [mark('one', { layerId: 'review' }), mark('two', { layerId: 'review', pageIndex: 1, kind: 'cloud', status: 'accepted' }), mark('three', { pageIndex: 1, kind: 'cloud', status: 'accepted', locked: true }), mark('four', { pageIndex: 1, kind: 'cloud', status: 'accepted', layerId: 'other' })];
  const before = structuredClone({ marks, layers });
  for (const item of marks) Object.freeze(item);
  Object.freeze(marks);
  assert.deepEqual(ids(queryMarkups(marks, layers, { text: 'CAFE\u0301', pageIndex: 1, kind: 'cloud', status: 'accepted', layerId: 'review', lock: 'locked' })), ['two']);
  assert.deepEqual(ids(queryMarkups(marks, layers, { lock: 'locked' })), ['one', 'two', 'three']);
  assert.deepEqual(ids(queryMarkups(marks, layers, { lock: 'unlocked' })), ['four']);
  assert.deepEqual(ids(queryMarkups(marks, layers, { layerId: '' })), ['three']);
  assert.deepEqual(queryMarkups(marks, layers, { layerId: 'missing' }), []);
  const copy = queryMarkups(marks, layers, {});
  assert.notEqual(copy, marks); assert.equal(copy[0], marks[0]);
  assert.deepEqual({ marks, layers }, before);
});

test('literal normalized search covers reviewer, page, group, stamp and hostile text without expressions', () => {
  const marks = [mark('safe:one', { pageIndex: 9, author: 'Renée', contents: '<script>alert("x")</script> .* [abc]', groupId: 'group-42' }), mark('stamp', { kind: 'stamp', stampName: 'NotForPublicRelease' })];
  for (const text of ['RENE\u0301E', 'page 10', 'group-42', 'safe:one', '<script>', '.* [abc]']) assert.deepEqual(ids(queryMarkups(marks, [], { text })), ['safe:one'], text);
  assert.deepEqual(ids(queryMarkups(marks, [], { text: 'notforpublicrelease' })), ['stamp']);
  assert.deepEqual(queryMarkups(marks, [], { text: '^safe' }), []);
  assert.deepEqual(ids(queryMarkups(marks, [], { text: '' })), ['safe:one', 'stamp']);
});

test('natural string sorting is stable in both directions and never changes source export order', () => {
  const marks = [mark('ten', { author: 'Reviewer 10' }), mark('two-a', { author: 'Reviewer 2' }), mark('two-b', { author: 'reviewer 2' }), mark('one', { author: 'Reviewer 1' })];
  assert.deepEqual(ids(queryMarkups(marks, [], { sort: 'author' })), ['one', 'two-a', 'two-b', 'ten']);
  assert.deepEqual(ids(queryMarkups(marks, [], { sort: 'author', direction: 'desc' })), ['ten', 'two-a', 'two-b', 'one']);
  assert.deepEqual(ids(queryMarkups(marks, [], { sort: 'source', direction: 'desc' })), ['ten', 'two-a', 'two-b', 'one']);
  assert.deepEqual(ids(marks), ['ten', 'two-a', 'two-b', 'one']);
});

test('page, status, timestamp, tool and resolved-layer sorts use their intended values', () => {
  const marks = [mark('later', { pageIndex: 10, status: 'rejected', layerId: 'other', kind: 'stamp', createdAt: '2026-10-22T00:00:00.000Z', modifiedAt: '2026-10-23T00:00:00.000Z' }), mark('earlier', { pageIndex: 2, status: 'open', layerId: 'review', kind: 'cloud' }), mark('middle', { pageIndex: 2, status: 'accepted', kind: 'ellipse', createdAt: '2026-10-21T13:00:00.000Z', modifiedAt: '2026-10-22T00:00:00.000Z' })];
  for (const sort of ['page', 'status', 'created', 'modified', 'kind']) {
    assert.deepEqual(ids(queryMarkups(marks, layers, { sort })), ['earlier', 'middle', 'later'], sort);
  }
  assert.deepEqual(ids(queryMarkups(marks, layers, { sort: 'page', direction: 'desc' })), ['later', 'earlier', 'middle']);
  assert.deepEqual(ids(queryMarkups(marks, layers, { sort: 'layer' })), ['middle', 'earlier', 'later']);
  assert.deepEqual(ids(queryMarkups(marks, layers, { status: 'all', kind: 'all', lock: 'all', pageIndex: 999 })), []);
});

test('malformed query options fail explicitly instead of silently broadening results', () => {
  for (const query of [null, [], 'x', { unknown: true }, { [Symbol('x')]: true }, { text: 4 }, { text: 'a'.repeat(10001) }, { status: 'approved' }, { kind: 'square' }, { lock: 'yes' }, { sort: 'contents' }, { direction: 'up' }, { pageIndex: -1 }, { pageIndex: 0.5 }, { pageIndex: NaN }, { pageIndex: Infinity }, { pageIndex: '1' }, { pageIndex: Number.MAX_SAFE_INTEGER + 1 }, { layerId: 'bad/id' }, { layerId: 2 }]) assert.throws(() => queryMarkups([], [], query));
  assert.deepEqual(queryMarkups([], [], { text: 'a'.repeat(10000), layerId: '', pageIndex: 0 }), []);
});

test('thread author, body and identity participate in literal review search without changing comments',()=>{
 const marks=[mark('with-thread',{comments:[{id:'comment-one',author:'Renée',contents:'Check valve schedule [A-1]',createdAt:time,modifiedAt:time}]}),mark('other')];
 const before=structuredClone(marks);
 for(const text of ['RENE\u0301E','valve schedule','comment-one','[A-1]'])assert.deepEqual(ids(queryMarkups(marks,[],{text})),['with-thread']);
 assert.deepEqual(marks,before);
});
