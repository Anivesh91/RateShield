import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, RedisStore } from '../src/index.js';

/**
 * Creates a simulated Redis client supporting deterministic time injection.
 */
function createDeterministicRedisClient() {
  const zsets = new Map();
  const strings = new Map();

  return {
    async eval(script, options) {
      const key = options.keys[0];

      // Sliding Window Lua simulation
      if (options.arguments.length >= 4) {
        const now = Number(options.arguments[0]);
        const windowMs = Number(options.arguments[1]);
        const limit = Number(options.arguments[2]);
        const member = options.arguments[3];

        const cutoff = now - windowMs;
        let entries = zsets.get(key) || [];

        // Prune expired entries: score <= cutoff
        entries = entries.filter((e) => e.score > cutoff);

        const currentCount = entries.length;
        let allowed = 0;

        if (currentCount < limit) {
          entries.push({ score: now, member });
          allowed = 1;
        }

        zsets.set(key, entries);

        const oldestScore = entries.length > 0 ? entries[0].score : now;
        return [allowed, entries.length, oldestScore];
      }

      // Fixed Window Lua simulation with deterministic time
      const windowMs = Number(options.arguments[0]);
      const now = Number(options.arguments[1] || Date.now());

      let entry = strings.get(key);
      if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
        entry = { count: 1, expiresAt: now + windowMs };
        strings.set(key, entry);
        return [1, windowMs];
      }

      entry.count += 1;
      const remainingTtl = Math.max(0, entry.expiresAt - now);
      return [entry.count, remainingTtl];
    },

    async sendCommand() {
      return 'OK';
    }
  };
}

describe('SmartRate v3 — Boundary-Burst Verification & Algorithm Comparison', () => {

  describe('MemoryStore: Boundary-Burst Prevention', () => {
    it('verifies boundary-burst prevention for the tested scenario on MemoryStore', () => {
      const store = new MemoryStore();
      const limit = 2;
      const windowMs = 60_000; // 60-second window

      const fixedKey = 'mem:burst:fixed';
      const slidingKey = 'mem:burst:sliding';

      // t = 0: Initial request establishes the active window
      const f1 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 0 });
      const s1 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 0 });
      assert.equal(f1.allowed, true);
      assert.equal(s1.allowed, true);

      // t = 59,500: Second request arrives near the end of the window (quota exhausted)
      const f2 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 59_500 });
      const s2 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 59_500 });
      assert.equal(f2.allowed, true);
      assert.equal(s2.allowed, true);

      // t = 60,001 (501ms after request 2):
      // FIXED WINDOW: Window reset boundary elapsed (60,001 >= 60,000).
      // Fixed Window resets and allows 2 more requests immediately:
      const f3 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 60_001 });
      const f4 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 60_002 });
      assert.equal(f3.allowed, true, 'Fixed Window allows request immediately after window boundary');
      assert.equal(f4.allowed, true, 'Fixed Window allows 2nd request in new bucket (4 total within ~502ms)');

      // SLIDING WINDOW: Rolling interval at t = 60,001 is (1, 60001].
      // Timestamp 0 has expired, but timestamp 59,500 is STILL ACTIVE.
      // Request 3 fills the single available slot:
      const s3 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 60_001 });
      assert.equal(s3.allowed, true);

      // Request 4 at t = 60,002: Active timestamps are [59500, 60001] -> Quota = 2 is FULL!
      // Sliding window strictly BLOCKS request 4, preventing the boundary burst!
      const s4 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 60_002 });
      assert.equal(s4.allowed, false, 'Sliding Window strictly blocks boundary burst');
      assert.equal(s4.remaining, 0);
      assert.ok(s4.retryAfter > 0);
    });
  });

  describe('RedisStore: Boundary-Burst Prevention', () => {
    it('verifies boundary-burst prevention for the tested scenario on RedisStore', async () => {
      const redisClient = createDeterministicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const limit = 2;
      const windowMs = 60_000;
      const slidingKey = 'redis:burst:sliding';

      // 1. First request at t = 10_000
      const r1 = await redisStore.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 10_000 });
      assert.equal(r1.allowed, true);
      assert.equal(r1.remaining, 1);

      // 2. Second request at t = 69_000 (quota exhausted)
      const r2 = await redisStore.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 69_000 });
      assert.equal(r2.allowed, true);
      assert.equal(r2.remaining, 0);

      // 3. At t = 70_001: Cutoff is 70_001 - 60_000 = 10_001.
      // Request from t = 10_000 has expired (10_000 <= 10_001).
      // Request from t = 69_000 is still active (69_000 > 10_001).
      // Slot 1 is available -> r3 allowed:
      const r3 = await redisStore.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 70_001 });
      assert.equal(r3.allowed, true);
      assert.equal(r3.remaining, 0);

      // 4. Request 4 at t = 70_002: Active timestamps are [69000, 70001].
      // Limit of 2 is full -> strictly blocked!
      const r4 = await redisStore.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 70_002 });
      assert.equal(r4.allowed, false, 'Redis Sliding Window strictly blocks boundary burst');
      assert.equal(r4.remaining, 0);
      assert.equal(r4.retryAfter, 59); // 69000 + 60000 - 70002 = 58998ms -> 59s
    });
  });

  describe('Memory vs Redis Behavioral Parity', () => {
    it('verifies equivalent observable sliding window semantics across MemoryStore and RedisStore', async () => {
      const memoryStore = new MemoryStore();
      const redisClient = createDeterministicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const limit = 3;
      const windowMs = 30_000;
      const clientKey = 'parity:test';

      const timeline = [
        { now: 10_000, expectedAllowed: true, expectedRemaining: 2 },
        { now: 15_000, expectedAllowed: true, expectedRemaining: 1 },
        { now: 20_000, expectedAllowed: true, expectedRemaining: 0 },
        { now: 25_000, expectedAllowed: false, expectedRemaining: 0 }, // quota full
        { now: 40_001, expectedAllowed: true, expectedRemaining: 0 },  // t=10_000 expired (cutoff 10_001), 1 slot freed
        { now: 40_002, expectedAllowed: false, expectedRemaining: 0 }  // quota full again
      ];

      for (const step of timeline) {
        const memRes = memoryStore.consume({
          key: clientKey,
          limit,
          windowMs,
          algorithm: 'sliding-window',
          now: step.now
        });

        const redisRes = await redisStore.consume({
          key: clientKey,
          limit,
          windowMs,
          algorithm: 'sliding-window',
          now: step.now
        });

        assert.equal(memRes.allowed, step.expectedAllowed, `MemoryStore parity at t=${step.now}`);
        assert.equal(redisRes.allowed, step.expectedAllowed, `RedisStore parity at t=${step.now}`);
        assert.equal(memRes.remaining, step.expectedRemaining, `MemoryStore remaining parity at t=${step.now}`);
        assert.equal(redisRes.remaining, step.expectedRemaining, `RedisStore remaining parity at t=${step.now}`);
        assert.equal(memRes.allowed, redisRes.allowed, `Observable allowance must match between engines at t=${step.now}`);
      }
    });
  });
});
