import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, RedisStore } from '../src/index.js';

/**
 * Creates an atomic simulated Redis client executing Token Bucket operations
 * with single-threaded queue serialization matching real Redis Lua guarantees.
 */
function createAtomicRedisClient() {
  const hashes = new Map(); // key -> { tokens: number, lastRefill: number }
  let queue = Promise.resolve();

  return {
    async eval(script, options) {
      return new Promise((resolve) => {
        queue = queue.then(async () => {
          const key = options.keys[0];
          const now = Number(options.arguments[0]);
          const capacity = Number(options.arguments[1]);
          const refillRate = Number(options.arguments[2]);
          const cost = Number(options.arguments[3]) || 1;

          let entry = hashes.get(key);
          let currentTokens = capacity;
          let lastRefill = now;

          if (entry) {
            const elapsedMs = Math.max(0, now - entry.lastRefill);
            const tokensToAdd = (elapsedMs / 1000) * refillRate;
            currentTokens = Math.min(capacity, entry.tokens + tokensToAdd);
            lastRefill = now;
          }

          let allowed = 0;
          let remaining = 0;
          let retryAfter = 0;

          if (currentTokens >= cost) {
            currentTokens -= cost;
            allowed = 1;
            remaining = Math.floor(currentTokens);
            lastRefill = now;
          } else {
            allowed = 0;
            remaining = Math.floor(currentTokens);
            const neededTokens = cost - currentTokens;
            retryAfter = Math.max(1, Math.ceil(neededTokens / refillRate));
          }

          hashes.set(key, { tokens: currentTokens, lastRefill });

          const reset = Math.max(1, Math.ceil((capacity - currentTokens) / refillRate));
          resolve([allowed, remaining, reset, retryAfter]);
        });
      });
    },

    getHash(key) {
      return hashes.get(key);
    },

    async sendCommand() {
      return 'OK';
    }
  };
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v4 — Redis Token Bucket & Concurrency Tests', () => {

  describe('RedisStore Token Bucket Unit Semantics', () => {
    it('allows initial burst up to configured capacity and blocks on empty bucket', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const key = 'smartrate:token-bucket:GET:/redis-tb:10.0.0.1';
      const capacity = 3;
      const refillRate = 1;
      const t0 = 100_000;

      // Req 1 at t0 -> Allowed (Tokens: 3 -> 2)
      const r1 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r1.allowed, true);
      assert.equal(r1.remaining, 2);

      // Req 2 at t0 -> Allowed (Tokens: 2 -> 1)
      const r2 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r2.allowed, true);
      assert.equal(r2.remaining, 1);

      // Req 3 at t0 -> Allowed (Tokens: 1 -> 0)
      const r3 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r3.allowed, true);
      assert.equal(r3.remaining, 0);

      // Req 4 at t0 -> Blocked 429
      const r4 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      assert.equal(r4.allowed, false);
      assert.equal(r4.remaining, 0);
      assert.equal(r4.retryAfter, 1);

      // Verify Redis Hash state
      const hash = redisClient.getHash(key);
      assert.ok(hash, 'Redis Hash must exist');
      assert.equal(hash.tokens, 0);
      assert.equal(hash.lastRefill, t0);
    });

    it('continuously refills tokens over time in Redis based on elapsed milliseconds', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const key = 'smartrate:token-bucket:GET:/redis-refill:10.0.0.2';
      const capacity = 5;
      const refillRate = 2; // 2 tokens/sec
      const t0 = 100_000;

      // Drain all 5 tokens at t0
      for (let i = 0; i < 5; i++) {
        await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });
      }

      // Advance 1,000ms -> exactly 2.0 tokens refilled
      const t1 = t0 + 1_000;
      const res1 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t1 });
      assert.equal(res1.allowed, true);
      assert.equal(res1.remaining, 1);

      const res2 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t1 });
      assert.equal(res2.allowed, true);
      assert.equal(res2.remaining, 0);

      // 3rd request blocked
      const res3 = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t1 });
      assert.equal(res3.allowed, false);
      assert.equal(res3.remaining, 0);
    });

    it('strictly caps accumulated tokens at maximum capacity', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const key = 'smartrate:token-bucket:GET:/redis-cap:10.0.0.3';
      const capacity = 4;
      const refillRate = 10;
      const t0 = 10_000;

      // Consume 1 token at t0
      await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: t0 });

      // Advance 24 hours into the future
      const tFuture = t0 + 86_400_000;

      for (let i = 0; i < 4; i++) {
        const res = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: tFuture });
        assert.equal(res.allowed, true);
      }

      const blocked = await redisStore.consume({ key, capacity, refillRate, algorithm: 'token-bucket', now: tFuture });
      assert.equal(blocked.allowed, false);
    });

    it('handles weighted request costs in RedisStore', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const key = 'smartrate:token-bucket:GET:/redis-weighted:10.0.0.4';
      const capacity = 10;
      const refillRate = 1;
      const t0 = 10_000;

      // Heavy request costing 7 tokens
      const rHeavy = await redisStore.consume({ key, capacity, refillRate, cost: 7, algorithm: 'token-bucket', now: t0 });
      assert.equal(rHeavy.allowed, true);
      assert.equal(rHeavy.remaining, 3); // 10 - 7 = 3 tokens left

      // Another request needing 5 tokens -> BLOCKED (needs 5, only 3 available)
      const rBlocked = await redisStore.consume({ key, capacity, refillRate, cost: 5, algorithm: 'token-bucket', now: t0 });
      assert.equal(rBlocked.allowed, false);
      assert.equal(rBlocked.remaining, 3);
      assert.equal(rBlocked.retryAfter, 2); // 5 - 3 = 2 tokens missing, 1 token/sec = 2s

      // Light request needing 2 tokens -> ALLOWED
      const rLight = await redisStore.consume({ key, capacity, refillRate, cost: 2, algorithm: 'token-bucket', now: t0 });
      assert.equal(rLight.allowed, true);
      assert.equal(rLight.remaining, 1);
    });
  });

  describe('Parallel Concurrency & Atomicity Stress Test', () => {
    it('verifies that allowed requests do not exceed configured capacity under 50 concurrent requests', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const CAPACITY = 10;
      const TOTAL_REQUESTS = 50;

      const app = createTestApp();
      app.get(
        '/api/tb-burst',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: CAPACITY,
          refillRate: 1,
          store: redisStore
        }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.200.5.1';

      // Dispatch 50 concurrent requests simultaneously via Promise.all
      const requestPromises = Array.from({ length: TOTAL_REQUESTS }, () =>
        request(app).get('/api/tb-burst').set('X-Forwarded-For', testIp)
      );

      const responses = await Promise.all(requestPromises);

      const allowedResponses = responses.filter((r) => r.status === 200);
      const blockedResponses = responses.filter((r) => r.status === 429);

      // Automated assertions verifying exact capacity enforcement without race conditions
      assert.equal(
        allowedResponses.length,
        CAPACITY,
        `Expected exactly ${CAPACITY} allowed requests under 50 concurrent requests, got ${allowedResponses.length}`
      );
      assert.equal(
        blockedResponses.length,
        TOTAL_REQUESTS - CAPACITY,
        `Expected exactly ${TOTAL_REQUESTS - CAPACITY} blocked requests, got ${blockedResponses.length}`
      );

      for (const res of blockedResponses) {
        assert.equal(res.body.success, false);
        assert.equal(res.headers['ratelimit-limit'], String(CAPACITY));
        assert.equal(res.headers['ratelimit-remaining'], '0');
        assert.ok(Number(res.headers['retry-after']) >= 1);
      }
    });

    it('enforces independent concurrent quotas for distinct client IPs in parallel', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const CAPACITY = 5;
      const app = createTestApp();
      app.get(
        '/api/tb-parallel-clients',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: CAPACITY,
          refillRate: 1,
          store: redisStore
        }),
        (req, res) => res.json({ success: true })
      );

      const clientA = '10.200.5.101';
      const clientB = '10.200.5.102';

      const promisesA = Array.from({ length: 15 }, () =>
        request(app).get('/api/tb-parallel-clients').set('X-Forwarded-For', clientA)
      );
      const promisesB = Array.from({ length: 15 }, () =>
        request(app).get('/api/tb-parallel-clients').set('X-Forwarded-For', clientB)
      );

      const [resultsA, resultsB] = await Promise.all([
        Promise.all(promisesA),
        Promise.all(promisesB)
      ]);

      const allowedA = resultsA.filter((r) => r.status === 200).length;
      const blockedA = resultsA.filter((r) => r.status === 429).length;

      const allowedB = resultsB.filter((r) => r.status === 200).length;
      const blockedB = resultsB.filter((r) => r.status === 429).length;

      assert.equal(allowedA, CAPACITY);
      assert.equal(blockedA, 10);
      assert.equal(allowedB, CAPACITY);
      assert.equal(blockedB, 10);
    });
  });

  describe('Express Integration & Headers with RedisStore Token Bucket', () => {
    it('sets accurate RateLimit and Retry-After headers on Express routes', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const app = createTestApp();
      app.get(
        '/api/redis-tb-headers',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 1,
          store: redisStore
        }),
        (req, res) => res.json({ success: true })
      );

      const clientIp = '10.200.5.200';

      const res1 = await request(app).get('/api/redis-tb-headers').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-limit'], '2');
      assert.equal(res1.headers['ratelimit-remaining'], '1');
      assert.ok(Number(res1.headers['ratelimit-reset']) > 0);

      const res2 = await request(app).get('/api/redis-tb-headers').set('X-Forwarded-For', clientIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      const res3 = await request(app).get('/api/redis-tb-headers').set('X-Forwarded-For', clientIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.body.success, false);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res3.headers['retry-after']) >= 1);
    });
  });
});
