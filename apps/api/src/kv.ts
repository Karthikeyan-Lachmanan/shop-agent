import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

/** Rate limits and per-session locks. Redis in production so replicas share state. */
export interface KV {
  /** Fixed-window counter; returns true while under the limit. */
  allow(key: string, limit: number, windowSec: number): Promise<boolean>;
  /** Returns a release function, or null if someone else holds the lock. */
  lock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
  /** Adds to a counter that expires ttlSec after it is created; returns the new total. */
  add(key: string, amount: number, ttlSec: number): Promise<number>;
  close(): Promise<void>;
}

export class MemoryKV implements KV {
  private counters = new Map<string, { count: number; resetAt: number }>();
  private locks = new Map<string, { token: string; expiresAt: number }>();

  async allow(key: string, limit: number, windowSec: number) {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return true;
    }
    c.count += 1;
    return c.count <= limit;
  }

  async add(key: string, amount: number, ttlSec: number) {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.resetAt <= now) {
      this.counters.set(key, { count: amount, resetAt: now + ttlSec * 1000 });
      return amount;
    }
    c.count += amount;
    return c.count;
  }

  async lock(key: string, ttlMs: number) {
    const now = Date.now();
    const held = this.locks.get(key);
    if (held && held.expiresAt > now) return null;
    const token = randomUUID();
    this.locks.set(key, { token, expiresAt: now + ttlMs });
    return async () => {
      if (this.locks.get(key)?.token === token) this.locks.delete(key);
    };
  }

  async close() {}
}

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export class RedisKV implements KV {
  private redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  }

  async allow(key: string, limit: number, windowSec: number) {
    const k = `rl:${key}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.expire(k, windowSec);
    return count <= limit;
  }

  async add(key: string, amount: number, ttlSec: number) {
    const k = `ctr:${key}`;
    const total = await this.redis.incrby(k, amount);
    if (total === amount) await this.redis.expire(k, ttlSec);
    return total;
  }

  async lock(key: string, ttlMs: number) {
    const k = `lock:${key}`;
    const token = randomUUID();
    const ok = await this.redis.set(k, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      await this.redis.eval(RELEASE, 1, k, token);
    };
  }

  async close() {
    await this.redis.quit();
  }
}
