import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStampText } from '../apps/opendraft/src/dynamic-stamps.ts';

test('dynamic stamp placeholders resolve at placement; other text is untouched', () => {
  const now = new Date(2026, 9, 22, 9, 5);
  assert.equal(resolveStampText('APPROVED {date} {time} by {author} p.{page}', { author: 'J. Smith', page: 3, now }), 'APPROVED 2026-10-22 09:05 by J. Smith p.3');
  assert.equal(resolveStampText('{DateTime}', { author: '', page: 1, now }), '2026-10-22 09:05');
  assert.equal(resolveStampText('{author} {unknown} {date', { author: ' ', page: 1, now }), 'Unknown {unknown} {date');
});
