import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, MemoryStore } from '../src/index.js';

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v3 — Memory Sliding Window Tests', () => {

  describe('Algorithm Option Validation', () => {
    it('defaults to fixed-window when algorithm is omitted', () => {
      const limiter = rateLimiter({ limit: 5, windowMs: 60_000 });
      assert.equal(typeof limiter, 'function');
    });

    it('accepts explicit algorithm: fixed-window', () => {
      const limiter = rateLimiter({ algorithm: 'fixed-window', limit: 5, windowMs: 60_000 });
      assert.equal(typeof limiter, 'function');
    });

    it('accepts explicit algorithm: sliding-window', () => {
      const limiter = rateLimiter({ algorithm: 'sliding-window', limit: 5, windowMs: 60_000 });
      assert.equal(typeof limiter, 'function');
    });

    it('fails fast when algorithm is unrecognized', () => {
      assert.throws(
        () => rateLimiter({ algorithm: 'leaky-bucket', limit: 5, windowMs: 60_000 }),
        {
          name: 'TypeError',
          message: /Unsupported algorithm 'leaky-bucket'/
        }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'random', limit: 5, windowMs: 60_000 }),
        {
          name: 'TypeError',
          message: /Unsupported algorithm 'random'/
        }
      );
    });
  });

  describe('MemoryStore Sliding Window Unit Semantics', () => {
    it('enforces quota sequentially using rolling timestamps', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:client1';
      const limit = 3;
      const windowMs = 60_000;
      const t0 = 100_000;

      // Req 1 at t0 -> Allowed
      const r1 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 });
      assert.equal(r1.allowed, true);
      assert.equal(r1.count, 1);
      assert.equal(r1.remaining, 2);

      // Req 2 at t0 + 1000 -> Allowed
      const r2 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 1000 });
      assert.equal(r2.allowed, true);
      assert.equal(r2.count, 2);
      assert.equal(r2.remaining, 1);

      // Req 3 at t0 + 2000 -> Allowed (Quota exhausted)
      const r3 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 2000 });
      assert.equal(r3.allowed, true);
      assert.equal(r3.count, 3);
      assert.equal(r3.remaining, 0);

      // Req 4 at t0 + 3000 -> Blocked
      const r4 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 3000 });
      assert.equal(r4.allowed, false);
      assert.equal(r4.count, 3);
      assert.equal(r4.remaining, 0);
      assert.ok(r4.retryAfter > 0);
    });

    it('enforces exact half-open interval boundary cutoff (now - windowMs, now]', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:boundary';
      const limit = 2;
      const windowMs = 10_000;

      // Request 1 at t = 10_000
      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 10_000 });
      // Request 2 at t = 15_000 (quota exhausted)
      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 15_000 });

      // At t = 20_000: cutoff = 20_000 - 10_000 = 10_000.
      // The timestamp 10_000 is <= cutoff, so it is strictly outside the rolling window (10000, 20000].
      // Exactly 1 slot opens up!
      const resAt20s = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 20_000 });
      assert.equal(resAt20s.allowed, true);
      assert.equal(resAt20s.count, 2); // 15_000 and 20_000 are in the active window
      assert.equal(resAt20s.remaining, 0);
    });

    it('calculates dynamic reset and retryAfter based on oldest relevant timestamp', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:reset';
      const limit = 1;
      const windowMs = 10_000;

      // First request at t = 100_000
      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 100_000 });

      // Second request at t = 103_000 (blocked)
      // Oldest request was at 100_000, expires at 110_000.
      // Time until slot opens: 110_000 - 103_000 = 7000ms = 7 seconds.
      const blocked = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 103_000 });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.reset, 7);
      assert.equal(blocked.retryAfter, 7);
    });

    it('cleans up stale sliding window records during periodic sweeper run', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:cleanup';
      const limit = 2;
      const windowMs = 10_000;

      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 1_000 });

      // Sweeper runs at t = 5,000 (window still active): 0 evicted
      const activeEvicted = store.cleanupExpiredRecords(5_000);
      assert.equal(activeEvicted, 0);

      // Sweeper runs at t = 12,000 (all timestamps expired): 1 record evicted
      const expiredEvicted = store.cleanupExpiredRecords(12_000);
      assert.equal(expiredEvicted, 1);
    });
  });

  describe('Boundary-Burst Comparison (Fixed Window vs Sliding Window)', () => {
    it('verifies boundary-burst prevention under tested scenario', () => {
      const store = new MemoryStore();
      const limit = 2;
      const windowMs = 10_000; // 10 second window

      const fixedKey = 'burst:fixed';
      const slidingKey = 'burst:sliding';

      // 1. Initial request at t = 0 to establish the window
      store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 0 });
      store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 0 });

      // 2. Near end of the first window at t = 9,500, a request arrives (quota exhausted)
      const f2 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 9_500 });
      const s2 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 9_500 });
      assert.equal(f2.allowed, true);
      assert.equal(s2.allowed, true);

      // 3. Just across the fixed window reset boundary at t = 10,001 (501ms after request 2):
      // FIXED WINDOW: Window elapsed (10,001 >= 10,000) -> Resets and allows a fresh quota!
      // Request at 10,001 is allowed (Req 3 in 501ms)
      const f3 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 10_001 });
      assert.equal(f3.allowed, true, 'Fixed Window allows request right after boundary reset');

      // Request at 10,002 is also allowed (Req 4 in 502ms! 3 requests in 502ms against limit 2!)
      const f4 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 10_002 });
      assert.equal(f4.allowed, true, 'Fixed Window allows full quota burst right after reset');

      // SLIDING WINDOW: Rolling interval at t = 10,001 is (1, 10001].
      // Timestamp 0 is pruned, but timestamp 9,500 is STILL ACTIVE.
      // Request at 10,001 takes the 2nd slot (allowed):
      const s3 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 10_001 });
      assert.equal(s3.allowed, true);

      // Request at 10,002: Active timestamps are [9500, 10001] -> Quota = 2 is FULL!
      // Sliding window strictly BLOCKS request 4, preventing the boundary burst!
      const s4 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 10_002 });
      assert.equal(s4.allowed, false, 'Sliding Window strictly blocks boundary burst');
      assert.equal(s4.remaining, 0);
      assert.equal(s4.retryAfter, 10); // 9500 + 10000 - 10002 = 9498ms -> 10 seconds
    });
  });

  describe('Express Integration with Sliding Window', () => {
    it('enforces sliding window on Express routes and sets correct headers', async () => {
      const app = createTestApp();
      app.get(
        '/api/sliding-resource',
        rateLimiter({
          algorithm: 'sliding-window',
          limit: 2,
          windowMs: 60_000
        }),
        (req, res) => res.json({ success: true })
      );

      const clientIp = '192.168.5.1';

      // Req 1
      const res1 = await request(app).get('/api/sliding-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-limit'], '2');
      assert.equal(res1.headers['ratelimit-remaining'], '1');

      // Req 2
      const res2 = await request(app).get('/api/sliding-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      // Req 3 (Blocked)
      const res3 = await request(app).get('/api/sliding-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.body.success, false);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res3.headers['retry-after']) > 0);
    });
  });
});
