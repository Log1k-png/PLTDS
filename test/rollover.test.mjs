import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldServeCached } from '../_worker.js';

function cachedResponse(entries, { status = 200, day = '227' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (day !== null) headers['x-cache-day'] = day;
  return new Response(JSON.stringify({ dayNumber: 227, difficulty: 'facile', entries }), {
    status,
    headers,
  });
}

const users = ['alice', 'bob'];
const entries = [
  { username: 'alice', score: 200, correctCount: 20 },
  { username: 'bob', score: 100, correctCount: 10 },
];

test('old day (>= 2): cache served regardless of marker', async () => {
  const cached = cachedResponse(entries, { day: '100' }); // marker very old
  const serve = await shouldServeCached(cached, false, 225, 227, null);
  assert.equal(serve, true);
});

test('today: served when marker matches current day', async () => {
  const cached = cachedResponse(entries, { day: '227' });
  const serve = await shouldServeCached(cached, true, 227, 227, null);
  assert.equal(serve, true);
});

test('yesterday: served when marker matches current day', async () => {
  const cached = cachedResponse(entries, { day: '227' });
  const serve = await shouldServeCached(cached, true, 226, 227, null);
  assert.equal(serve, true);
});

test('yesterday: NOT served when marker predates rollover (bonus bug)', async () => {
  const cached = cachedResponse(entries, { day: '226' }); // written under previous day
  const serve = await shouldServeCached(cached, true, 226, 227, null);
  assert.equal(serve, false);
});

test('error response in cache: never served', async () => {
  const cached = cachedResponse([], { status: 502, day: '227' });
  const serve = await shouldServeCached(cached, true, 227, 227, null);
  assert.equal(serve, false);
});

test('today + users: served when all requested players present', async () => {
  const cached = cachedResponse(entries, { day: '227' });
  const serve = await shouldServeCached(cached, true, 227, 227, 'alice,bob');
  assert.equal(serve, true);
});

test('today + users: NOT served when a player is missing', async () => {
  const cached = cachedResponse(entries, { day: '227' });
  const serve = await shouldServeCached(cached, true, 227, 227, 'alice,carol');
  assert.equal(serve, false);
});