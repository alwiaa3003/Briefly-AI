'use strict';

/**
 * Storage for the AI request manager (budgets, minute windows, provider
 * blocks, concurrency leases, locks).
 *
 * RedisStore is shared by the API and every worker, so limits hold across
 * processes. All check-and-increment operations run as Lua scripts, so
 * concurrent callers can never overshoot a budget. MemoryStore implements the
 * same semantics in-process (tests, or while Redis is unavailable).
 */

const crypto = require('crypto');

// One hash tag keeps every key in the same Redis Cluster slot (required for multi-key scripts).
const PREFIX = 'briefly-ai:{q}:';

const RESERVE_LUA = `
local n = #KEYS
for i = 1, n do
  local v = tonumber(redis.call('HGET', KEYS[i], ARGV[2 * i]) or '0')
  if v + tonumber(ARGV[2 * i + 1]) > tonumber(ARGV[2 * n + 2 + i]) then return i end
end
for i = 1, n do
  redis.call('HINCRBY', KEYS[i], ARGV[2 * i], ARGV[2 * i + 1])
  redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1]))
end
return 0`;

const ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0`;

class RedisStore {
  constructor(redis) {
    this.redis = redis;
    this.kind = 'redis';
  }

  /**
   * Atomically adds `amount` to every counter if none would exceed its limit.
   * @param {{key:string, field:string, amount?:number, limit:number}[]} counters
   * @returns {Promise<number>} -1 when reserved, otherwise the index of the first counter that is full.
   */
  async reserve(counters, ttlSeconds) {
    if (!counters.length) return -1;
    const keys = counters.map((c) => PREFIX + c.key);
    const args = [String(ttlSeconds)];
    for (const c of counters) args.push(c.field, String(c.amount ?? 1));
    args.push('_');
    for (const c of counters) args.push(String(c.limit));
    const failed = Number(await this.redis.eval(RESERVE_LUA, keys.length, ...keys, ...args));
    return failed === 0 ? -1 : failed - 1;
  }

  /** Unconditional increments, e.g. {key, field, amount} (negative to release a reservation). */
  async add(entries, ttlSeconds) {
    if (!entries.length) return;
    const pipeline = this.redis.multi();
    for (const e of entries) {
      pipeline.hincrby(PREFIX + e.key, e.field, e.amount);
      pipeline.expire(PREFIX + e.key, ttlSeconds);
    }
    await pipeline.exec();
  }

  async getHash(key) {
    const raw = await this.redis.hgetall(PREFIX + key);
    return Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, Number(v)]));
  }

  async setValue(key, value, ttlMs) {
    await this.redis.set(PREFIX + key, JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlMs)));
  }

  async getValue(key) {
    const raw = await this.redis.get(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }

  async ttlMs(key) {
    return Number(await this.redis.pttl(PREFIX + key));
  }

  async acquire(key, limit, ttlMs, id) {
    const now = Date.now();
    return (await this.redis.eval(ACQUIRE_LUA, 1, PREFIX + key, String(now), String(limit), String(now + ttlMs), id, String(ttlMs))) === 1;
  }

  async release(key, id) {
    await this.redis.zrem(PREFIX + key, id);
  }

  async setIfAbsent(key, ttlMs) {
    return (await this.redis.set(PREFIX + key, '1', 'PX', Math.round(ttlMs), 'NX')) === 'OK';
  }

  async del(key) {
    await this.redis.del(PREFIX + key);
  }
}

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.hashes = new Map();
    this.values = new Map();
    this.leases = new Map();
  }

  #hash(key) {
    const entry = this.hashes.get(key);
    if (entry && entry.expires > Date.now()) return entry;
    const fresh = { data: {}, expires: Infinity };
    this.hashes.set(key, fresh);
    return fresh;
  }

  async reserve(counters, ttlSeconds) {
    for (let i = 0; i < counters.length; i += 1) {
      const c = counters[i];
      if ((this.#hash(c.key).data[c.field] || 0) + (c.amount ?? 1) > c.limit) return i;
    }
    for (const c of counters) {
      const h = this.#hash(c.key);
      h.data[c.field] = (h.data[c.field] || 0) + (c.amount ?? 1);
      h.expires = Date.now() + ttlSeconds * 1000;
    }
    return -1;
  }

  async add(entries, ttlSeconds) {
    for (const e of entries) {
      const h = this.#hash(e.key);
      h.data[e.field] = (h.data[e.field] || 0) + e.amount;
      h.expires = Date.now() + ttlSeconds * 1000;
    }
  }

  async getHash(key) {
    return { ...this.#hash(key).data };
  }

  async setValue(key, value, ttlMs) {
    this.values.set(key, { value, expires: Date.now() + ttlMs });
  }

  async getValue(key) {
    const entry = this.values.get(key);
    if (!entry || entry.expires <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async ttlMs(key) {
    const entry = this.values.get(key);
    return entry && entry.expires > Date.now() ? entry.expires - Date.now() : -2;
  }

  async acquire(key, limit, ttlMs, id) {
    const now = Date.now();
    const lease = new Map([...(this.leases.get(key) || new Map())].filter(([, exp]) => exp > now));
    if (lease.size >= limit) {
      this.leases.set(key, lease);
      return false;
    }
    lease.set(id, now + ttlMs);
    this.leases.set(key, lease);
    return true;
  }

  async release(key, id) {
    this.leases.get(key)?.delete(id);
  }

  async setIfAbsent(key, ttlMs) {
    if (await this.getValue(key)) return false;
    await this.setValue(key, 1, ttlMs);
    return true;
  }

  async del(key) {
    this.values.delete(key);
    this.hashes.delete(key);
  }

  reset() {
    this.hashes.clear();
    this.values.clear();
    this.leases.clear();
  }
}

const newId = () => crypto.randomUUID();

module.exports = { RedisStore, MemoryStore, newId, PREFIX };
