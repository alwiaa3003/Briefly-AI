'use strict';

/**
 * The AI request manager's Redis store against the REAL Redis (npm run test:infra):
 * atomic budget reservations under concurrency, leases and locks, shared by every
 * API / worker process. Uses random throwaway keys and deletes them afterwards.
 */

const crypto = require('crypto');
const { createRedisConnection } = require('../../src/config/redis');
const { RedisStore } = require('../../src/services/ai/gateStore');

let redis;
let store;
const run = `infra-${crypto.randomUUID()}`;
const keys = [];
const key = (name) => {
  const k = `${run}:${name}`;
  keys.push(k);
  return k;
};

beforeAll(async () => {
  redis = createRedisConnection('ai-gate-infra-test');
  await new Promise((resolve, reject) => {
    redis.once('ready', resolve);
    redis.once('error', reject);
  });
  store = new RedisStore(redis);
});

afterAll(async () => {
  for (const k of keys) await store.del(k);
  await redis.quit();
});

test('concurrent reservations never exceed a budget (Lua check-and-increment)', async () => {
  const budget = key('budget');
  const results = await Promise.all(
    Array.from({ length: 12 }, () => store.reserve([{ key: budget, field: 'generation', limit: 5 }], 60))
  );
  expect(results.filter((r) => r === -1)).toHaveLength(5);
  expect((await store.getHash(budget)).generation).toBe(5);
});

test('multi-counter reservation is all-or-nothing and reports which counter is full', async () => {
  const app = key('app');
  const user = key('user');
  await store.reserve([{ key: user, field: 'generation', limit: 1 }], 60);
  const failed = await store.reserve(
    [
      { key: app, field: 'generation', limit: 10 },
      { key: user, field: 'generation', limit: 1 },
    ],
    60
  );
  expect(failed).toBe(1);
  expect((await store.getHash(app)).generation).toBeUndefined();
  await store.add([{ key: user, field: 'generation', amount: -1 }], 60);
  expect((await store.getHash(user)).generation).toBe(0);
});

test('leases bound concurrency and expire; locks prevent duplicates; values carry a TTL', async () => {
  const lease = key('lease');
  expect(await store.acquire(lease, 1, 60000, 'a')).toBe(true);
  expect(await store.acquire(lease, 1, 60000, 'b')).toBe(false);
  await store.release(lease, 'a');
  expect(await store.acquire(lease, 1, 50, 'b')).toBe(true);
  await new Promise((r) => setTimeout(r, 120));
  expect(await store.acquire(lease, 1, 60000, 'c')).toBe(true); // b's lease expired

  const lock = key('lock');
  expect(await store.setIfAbsent(lock, 60000)).toBe(true);
  expect(await store.setIfAbsent(lock, 60000)).toBe(false);

  const block = key('block');
  await store.setValue(block, { code: 'AI_QUOTA_EXHAUSTED', until: Date.now() + 5000 }, 5000);
  expect((await store.getValue(block)).code).toBe('AI_QUOTA_EXHAUSTED');
  expect(await store.ttlMs(block)).toBeGreaterThan(0);
});
