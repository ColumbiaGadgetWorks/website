import test from 'node:test';
import assert from 'node:assert/strict';
import { announceName, announceable, readTransaction } from './fund-givebutter.js';

test('first name only, none when anonymous', () => {
  assert.equal(announceName({ donor: 'Jane Q. Public', anonymous: false }), 'Jane');
  assert.equal(announceName({ donor: 'Jane Public', anonymous: true }), null);
  assert.equal(announceName({ donor: null, anonymous: false }), null);
});

test('readTransaction flags anonymous gifts', () => {
  assert.equal(readTransaction({ id: 1, giving_space: { name: 'Anonymous' } }).anonymous, true);
  assert.equal(readTransaction({ id: 2, giving_space: { name: 'Sam Lee' } }).anonymous, false);
  assert.equal(readTransaction({ id: 3, is_anonymous: true, giving_space: { name: 'Sam Lee' } }).anonymous, true);
});

test('announceable applies threshold and freshness', () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 3600e3).toISOString();
  const got = announceable({}, [
    { id: 'a', amount: 4.99, ts: now },
    { id: 'b', amount: 5, ts: now },
    { id: 'c', amount: 500, ts: old },
  ]);
  assert.deepEqual(got.map((t) => t.id), ['b']);
});
