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

describe('SmartRate v4 — Memory Token Bucket Unit & Integration Tests', () => {

  describe('Option Validation for Token Bucket', () => {
    it('throws RangeError when capacity is <= 0 or not an integer', () => {
      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 0, refillRate: 1 }),
        { name: 'RangeError', message: /positive integer 'capacity'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: -5, refillRate: 1 }),
        { name: 'RangeError', message: /positive integer 'capacity'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 2.5, refillRate: 1 }),
        { name: 'RangeError', message: /positive integer 'capacity'/ }
      );
    });

    it('throws RangeError when refillRate is <= 0 or non-finite', () => {
      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 0 }),
        { name: 'RangeError', message: /positive number 'refillRate'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: -1 }),
        { name: 'RangeError', message: /positive number 'refillRate'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: Infinity }),
        { name: 'RangeError', message: /positive number 'refillRate'/ }
      );
    });

    it('throws RangeError or TypeError on invalid cost parameter', () => {
      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, cost: 'invalid' }),
        { name: 'TypeError', message: /'cost' must be a positive integer or a function/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, cost: 0 }),
        { name: 'RangeError', message: /'cost' must be a positive integer/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, cost: -2 }),
        { name: 'RangeError', message: /'cost' must be a positive integer/ }
      );
    });

    it('throws RangeError when refillIntervalMs is <= 0, non-finite, or invalid type', () => {
      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, refillIntervalMs: 0 }),
        { name: 'RangeError', message: /positive number 'refillIntervalMs'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, refillIntervalMs: -500 }),
        { name: 'RangeError', message: /positive number 'refillIntervalMs'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, refillIntervalMs: NaN }),
        { name: 'RangeError', message: /positive number 'refillIntervalMs'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, refillIntervalMs: Infinity }),
        { name: 'RangeError', message: /positive number 'refillIntervalMs'/ }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'token-bucket', capacity: 5, refillRate: 1, refillIntervalMs: '1000' }),
        { name: 'RangeError', message: /positive number 'refillIntervalMs'/ }
      );
    });

    it('accepts valid capacity, refillRate, refillIntervalMs or limit/windowMs mapping', () => {
      const explicitLimiter = rateLimiter({
        algorithm: 'token-bucket',
        capacity: 10,
        refillRate: 2,
        refillIntervalMs: 2000
      });
      assert.equal(typeof explicitLimiter, 'function');

      const mappedLimiter = rateLimiter({
        algorithm: 'token-bucket',
        limit: 10,
        windowMs: 5000 // capacity = 10, refillRate = 10 / 5 = 2 tokens/sec
      });
      assert.equal(typeof mappedLimiter, 'function');
    });
  });

  describe('MemoryStore Token Bucket Unit Semantics', () => {
    it('allows initial burst up to configured capacity and blocks on empty bucket', () => {
      const store = new MemoryStore();
      const key = 'tb:burst:test';
      const capacity = 3;
      const refillRate = 1; // 1 token per second
      const t0 = 100_000;

      // Req 1 at t0 -> Allowed (Tokens: 3 -> 2)
      const r1 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r1.allowed, true);
      assert.equal(r1.remaining, 2);

      // Req 2 at t0 -> Allowed (Tokens: 2 -> 1)
      const r2 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r2.allowed, true);
      assert.equal(r2.remaining, 1);

      // Req 3 at t0 -> Allowed (Tokens: 1 -> 0, bucket empty)
      const r3 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r3.allowed, true);
      assert.equal(r3.remaining, 0);

      // Req 4 at t0 -> Blocked (Tokens: 0 < 1)
      const r4 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r4.allowed, false);
      assert.equal(r4.remaining, 0);
      assert.equal(r4.retryAfter, 1); // 1 token needed at 1 token/sec = 1s
    });

    it('continuously refills tokens over time based on elapsed milliseconds', () => {
      const store = new MemoryStore();
      const key = 'tb:refill:test';
      const capacity = 5;
      const refillRate = 2; // 2 tokens per second (1 token every 500ms)
      const t0 = 100_000;

      // Empty the bucket at t0 (5 requests)
      for (let i = 0; i < 5; i++) {
        const res = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
        assert.equal(res.allowed, true);
      }

      // Blocked at t0
      const blockedAtT0 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(blockedAtT0.allowed, false);

      // Advance 1,000ms (1 second) -> 1,000 * (2/1000) = 2.0 tokens refilled!
      const t1 = t0 + 1_000;
      const res1 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t1 });
      assert.equal(res1.allowed, true);
      assert.equal(res1.remaining, 1); // 2 - 1 = 1 token left

      const res2 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t1 });
      assert.equal(res2.allowed, true);
      assert.equal(res2.remaining, 0); // 1 - 1 = 0 tokens left

      // 3rd request at t1 must be blocked
      const res3 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t1 });
      assert.equal(res3.allowed, false);
      assert.equal(res3.remaining, 0);
    });

    it('strictly caps accumulated tokens at the maximum capacity', () => {
      const store = new MemoryStore();
      const key = 'tb:cap:test';
      const capacity = 4;
      const refillRate = 10; // 10 tokens per second
      const t0 = 10_000;

      // Initial request consumes 1 token (Tokens: 4 -> 3)
      store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });

      // Advance 1 hour into the future (3,600,000ms)
      const tFuture = t0 + 3_600_000;

      // Even though thousands of tokens could have mathematically generated,
      // tokens must be capped at capacity (4).
      // Consuming 4 requests must succeed, but the 5th must be blocked:
      for (let i = 0; i < 4; i++) {
        const res = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: tFuture });
        assert.equal(res.allowed, true, `Request ${i + 1} should be allowed up to capacity`);
      }

      const blocked5 = store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: tFuture });
      assert.equal(blocked5.allowed, false, '5th request exceeding capacity must be blocked');
    });

    it('supports custom refillIntervalMs (e.g. 100 tokens per 60,000ms continuous refill)', () => {
      const store = new MemoryStore();
      const key = 'tb:interval:test';
      const capacity = 5;
      const refillRate = 100;
      const refillIntervalMs = 60_000; // 100 tokens per minute -> 1 token every 600ms
      const t0 = 100_000;

      // Drain all 5 tokens at t0
      for (let i = 0; i < 5; i++) {
        const res = store.consume({
          key,
          capacity,
          refillRate,
          refillIntervalMs,
          algorithm: 'token-bucket',
          now: t0
        });
        assert.equal(res.allowed, true);
      }

      // Blocked at t0
      const blockedT0 = store.consume({
        key,
        capacity,
        refillRate,
        refillIntervalMs,
        algorithm: 'token-bucket',
        now: t0
      });
      assert.equal(blockedT0.allowed, false);

      // Advance 300ms: 300 * (100 / 60000) = 0.5 tokens accumulated. Still < 1, so BLOCKED!
      const t300 = t0 + 300;
      const res300 = store.consume({
        key,
        capacity,
        refillRate,
        refillIntervalMs,
        algorithm: 'token-bucket',
        now: t300
      });
      assert.equal(res300.allowed, false);
      assert.equal(res300.remaining, 0);

      // Advance 600ms: 600 * (100 / 60000) = 1.0 token accumulated. Now >= 1, so ALLOWED!
      const t600 = t0 + 600;
      const res600 = store.consume({
        key,
        capacity,
        refillRate,
        refillIntervalMs,
        algorithm: 'token-bucket',
        now: t600
      });
      assert.equal(res600.allowed, true);
      assert.equal(res600.remaining, 0);
    });

    it('calculates smart Retry-After for 1 token instead of waiting for full bucket refill', () => {
      const store = new MemoryStore();
      const key = 'tb:retryafter:test';
      const capacity = 10;
      const refillRate = 2; // 2 tokens/sec
      const refillIntervalMs = 1000;
      const t0 = 100_000;

      // Drain all 10 tokens at t0
      for (let i = 0; i < 10; i++) {
        store.consume({ key, capacity, refillRate, refillIntervalMs, algorithm: 'token-bucket', now: t0 });
      }

      // Advance 100ms -> 0.2 tokens refilled. Missing 0.8 tokens to reach 1.0 token.
      // 0.8 tokens at 0.002 tokens/ms requires 400ms.
      // In seconds: ceil(400 / 1000) = 1 second.
      // (Full bucket refill would have been 9.8 / 2 = 5 seconds)
      const t100 = t0 + 100;
      const blockedRes = store.consume({
        key,
        capacity,
        refillRate,
        refillIntervalMs,
        algorithm: 'token-bucket',
        now: t100
      });

      assert.equal(blockedRes.allowed, false);
      assert.equal(blockedRes.retryAfter, 1);
      assert.equal(blockedRes.reset, 1);
    });

    it('handles weighted request costs (e.g. cost = 5 for expensive operation)', () => {
      const store = new MemoryStore();
      const key = 'tb:weighted:test';
      const capacity = 10;
      const refillRate = 2; // 2 tokens/sec
      const t0 = 50_000;

      // Heavy request 1: cost = 6 (Tokens: 10 -> 4)
      const r1 = store.consume({ key, capacity, refillRate, cost: 6, algorithm: 'token-bucket', now: t0 });
      assert.equal(r1.allowed, true);
      assert.equal(r1.remaining, 4);

      // Heavy request 2: cost = 5 (Needs 5, only 4 available -> BLOCKED)
      const r2 = store.consume({ key, capacity, refillRate, cost: 5, algorithm: 'token-bucket', now: t0 });
      assert.equal(r2.allowed, false);
      assert.equal(r2.remaining, 4);
      // Missing tokens = 5 - 4 = 1 token. At 2 tokens/sec, ceil(1/2) = 1s
      assert.equal(r2.retryAfter, 1);
      assert.equal(r2.reset, 1);

      // Light request: cost = 2 (Tokens: 4 -> 2) -> ALLOWED!
      const r3 = store.consume({ key, capacity, refillRate, cost: 2, algorithm: 'token-bucket', now: t0 });
      assert.equal(r3.allowed, true);
      assert.equal(r3.remaining, 2);
    });

    it('isolates buckets between different rate limit keys', () => {
      const store = new MemoryStore();
      const keyA = 'tb:user:alice';
      const keyB = 'tb:user:bob';
      const capacity = 2;
      const refillRate = 1;
      const t0 = 10_000;

      // Exhaust Alice's bucket
      store.consume({ key: keyA, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      store.consume({ key: keyA, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      const blockedAlice = store.consume({ key: keyA, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(blockedAlice.allowed, false);

      // Bob's bucket must remain completely full
      const bobRes1 = store.consume({ key: keyB, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(bobRes1.allowed, true);
      assert.equal(bobRes1.remaining, 1);
    });

    it('evicts idle full token buckets during periodic cleanup sweeper runs', () => {
      const store = new MemoryStore();
      const key = 'tb:cleanup:test';
      const capacity = 5;
      const refillRate = 1;
      const t0 = 10_000;

      // Consume 1 token at t0
      store.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });

      // Run sweeper at t0 + 1,000ms (bucket is still refilling, not idle): 0 evicted
      const notEvicted = store.cleanupExpiredRecords(t0 + 1_000);
      assert.equal(notEvicted, 0);

      // Run sweeper when bucket has fully refilled and remained idle (> fullTime + 60s): 1 evicted
      const fullTimeMs = (1 / 1) * 1000; // 1s to refill 1 token
      const tIdle = t0 + fullTimeMs + 65_000;
      const evicted = store.cleanupExpiredRecords(tIdle);
      assert.equal(evicted, 1);
    });
  });

  describe('Express Integration & Headers with Token Bucket', () => {
    it('enforces token bucket on Express routes and sets correct headers', async () => {
      const app = createTestApp();

      app.get(
        '/api/token-resource',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 3,
          refillRate: 1
        }),
        (req, res) => res.json({ success: true })
      );

      const clientIp = '192.168.99.1';

      // Req 1: Allowed, remaining = 2
      const res1 = await request(app).get('/api/token-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-limit'], '3');
      assert.equal(res1.headers['ratelimit-remaining'], '2');
      assert.ok(Number(res1.headers['ratelimit-reset']) > 0);

      // Req 2: Allowed, remaining = 1
      const res2 = await request(app).get('/api/token-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '1');

      // Req 3: Allowed, remaining = 0
      const res3 = await request(app).get('/api/token-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res3.status, 200);
      assert.equal(res3.headers['ratelimit-remaining'], '0');

      // Req 4: Blocked 429
      const res4 = await request(app).get('/api/token-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res4.status, 429);
      assert.equal(res4.body.success, false);
      assert.equal(res4.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res4.headers['retry-after']) >= 1);
    });

    it('supports request-dependent dynamic cost functions', async () => {
      const app = createTestApp();

      app.post(
        '/api/operations',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 10,
          refillRate: 1,
          cost: (req) => Number(req.headers['x-operation-cost'] || 1)
        }),
        (req, res) => res.json({ success: true })
      );

      const clientIp = '192.168.99.2';

      // Send expensive operation costing 8 tokens
      const resHeavy = await request(app)
        .post('/api/operations')
        .set('X-Forwarded-For', clientIp)
        .set('X-Operation-Cost', '8');
      assert.equal(resHeavy.status, 200);
      assert.equal(resHeavy.headers['ratelimit-remaining'], '2'); // 10 - 8 = 2 tokens left

      // Another operation costing 4 tokens -> BLOCKED (needs 4, only 2 left)
      const resBlocked = await request(app)
        .post('/api/operations')
        .set('X-Forwarded-For', clientIp)
        .set('X-Operation-Cost', '4');
      assert.equal(resBlocked.status, 429);
      assert.equal(resBlocked.headers['ratelimit-remaining'], '2');

      // Light operation costing 2 tokens -> ALLOWED (2 tokens available)
      const resLight = await request(app)
        .post('/api/operations')
        .set('X-Forwarded-For', clientIp)
        .set('X-Operation-Cost', '2');
      assert.equal(resLight.status, 200);
      assert.equal(resLight.headers['ratelimit-remaining'], '0');
    });
  });
});
