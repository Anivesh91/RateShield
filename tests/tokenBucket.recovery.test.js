import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, MemoryStore, RedisStore } from '../src/index.js';

/**
 * Creates an in-memory atomic Redis client simulator supporting Token Bucket Lua semantics.
 */
function createDistributedRedisClient() {
  const hashes = new Map();
  let queue = Promise.resolve();

  return {
    async eval(script, options) {
      return new Promise((resolve) => {
        queue = queue.then(async () => {
          const key = options.keys[0];
          const now = Number(options.arguments[0]);
          const capacity = Number(options.arguments[1]);
          const refillRate = Number(options.arguments[2]);
          const refillIntervalMs = Number(options.arguments[3]) || 1000;
          const cost = Number(options.arguments[4]) || 1;

          const refillPerMs = refillRate / refillIntervalMs;

          let entry = hashes.get(key);
          let currentTokens = capacity;
          let lastRefill = now;

          if (entry) {
            const elapsedMs = Math.max(0, now - entry.lastRefill);
            const tokensToAdd = elapsedMs * refillPerMs;
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
            const waitMs = neededTokens / refillPerMs;
            retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
          }

          hashes.set(key, { tokens: currentTokens, lastRefill });

          // Option C RateLimit-Reset:
          // Allowed -> time to full capacity
          // Blocked -> time until next token eligibility (retryAfter)
          let reset;
          if (allowed === 1) {
            const timeToFullMs = Math.max(0, (capacity - currentTokens) / refillPerMs);
            reset = Math.max(1, Math.ceil(timeToFullMs / 1000));
          } else {
            reset = retryAfter;
          }

          resolve([allowed, remaining, reset, retryAfter]);
        });
      });
    },

    async sendCommand() {
      return 'OK';
    }
  };
}

function createExpressApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v5 — Day 3: Token Bucket Concurrency, Identity, Distributed State & HTTP Recovery', () => {

  describe('1. RateLimit-Reset & Header Parity (Memory ↔ Redis Option C Semantics)', () => {
    // Note: For Token Bucket, RateLimit-Reset does not represent a fixed-window boundary.
    // On allowed responses it indicates time to full bucket restoration;
    // on blocked responses it indicates the next request-eligibility point (matching Retry-After).

    it('enforces exact Option C RateLimit-Reset on allowed responses in both MemoryStore and RedisStore', async () => {
      const memoryStore = new MemoryStore();
      const redisClient = createDistributedRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const capacity = 10;
      const refillRate = 2; // 2 tokens/sec -> full bucket takes 5s from 0
      const refillIntervalMs = 1000;
      const t0 = 500_000;

      // Consume 4 tokens from both stores: remaining = 6
      const memRes = memoryStore.consume({
        key: 'tb:parity:allowed',
        capacity,
        refillRate,
        refillIntervalMs,
        cost: 4,
        algorithm: 'token-bucket',
        now: t0
      });

      const redisRes = await redisStore.consume({
        key: 'tb:parity:allowed',
        capacity,
        refillRate,
        refillIntervalMs,
        cost: 4,
        algorithm: 'token-bucket',
        now: t0
      });

      // Allowed response: reset = ceil((10 - 6) / 2) = 2 seconds to full capacity
      assert.equal(memRes.allowed, true);
      assert.equal(redisRes.allowed, true);

      assert.equal(memRes.remaining, 6);
      assert.equal(redisRes.remaining, 6);

      assert.equal(memRes.reset, 2);
      assert.equal(redisRes.reset, 2);

      assert.equal(memRes.retryAfter, undefined);
      assert.equal(redisRes.retryAfter, undefined);
    });

    it('enforces exact Option C RateLimit-Reset on blocked responses (reset === retryAfter) in both stores', async () => {
      const memoryStore = new MemoryStore();
      const redisClient = createDistributedRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const capacity = 3;
      const refillRate = 1; // 1 token/sec
      const refillIntervalMs = 1000;
      const t0 = 100_000;

      // Drain all 3 tokens
      for (let i = 0; i < 3; i++) {
        memoryStore.consume({ key: 'tb:parity:blocked', capacity, refillRate, refillIntervalMs, algorithm: 'token-bucket', now: t0 });
        await redisStore.consume({ key: 'tb:parity:blocked', capacity, refillRate, refillIntervalMs, algorithm: 'token-bucket', now: t0 });
      }

      // Next request at t0 is blocked: 0 tokens available, needs 1 token
      // Wait time = 1s -> retryAfter = 1, reset = 1
      const memBlocked = memoryStore.consume({
        key: 'tb:parity:blocked',
        capacity,
        refillRate,
        refillIntervalMs,
        algorithm: 'token-bucket',
        now: t0
      });

      const redisBlocked = await redisStore.consume({
        key: 'tb:parity:blocked',
        capacity,
        refillRate,
        refillIntervalMs,
        algorithm: 'token-bucket',
        now: t0
      });

      assert.equal(memBlocked.allowed, false);
      assert.equal(redisBlocked.allowed, false);

      assert.equal(memBlocked.remaining, 0);
      assert.equal(redisBlocked.remaining, 0);

      // Reset equals Retry-After on blocked requests (next eligibility point)
      assert.equal(memBlocked.retryAfter, 1);
      assert.equal(redisBlocked.retryAfter, 1);
      assert.equal(memBlocked.reset, memBlocked.retryAfter);
      assert.equal(redisBlocked.reset, redisBlocked.retryAfter);
    });

    it('sets identical HTTP headers across Express routes using MemoryStore and RedisStore', async () => {
      const redisClient = createDistributedRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const appMem = createExpressApp();
      appMem.get('/api/test', rateLimiter({
        algorithm: 'token-bucket',
        capacity: 2,
        refillRate: 1,
        refillIntervalMs: 1000
      }), (req, res) => res.json({ ok: true }));

      const appRedis = createExpressApp();
      appRedis.get('/api/test', rateLimiter({
        algorithm: 'token-bucket',
        capacity: 2,
        refillRate: 1,
        refillIntervalMs: 1000,
        store: redisStore
      }), (req, res) => res.json({ ok: true }));

      const clientIp = '10.0.0.1';

      // Request 1: Allowed (rem: 1)
      const resMem1 = await request(appMem).get('/api/test').set('X-Forwarded-For', clientIp);
      const resRedis1 = await request(appRedis).get('/api/test').set('X-Forwarded-For', clientIp);
      assert.equal(resMem1.headers['ratelimit-limit'], resRedis1.headers['ratelimit-limit']);
      assert.equal(resMem1.headers['ratelimit-remaining'], resRedis1.headers['ratelimit-remaining']);
      assert.equal(resMem1.headers['ratelimit-reset'], resRedis1.headers['ratelimit-reset']);

      // Request 2: Allowed (rem: 0)
      const resMem2 = await request(appMem).get('/api/test').set('X-Forwarded-For', clientIp);
      const resRedis2 = await request(appRedis).get('/api/test').set('X-Forwarded-For', clientIp);
      assert.equal(resMem2.headers['ratelimit-remaining'], '0');
      assert.equal(resRedis2.headers['ratelimit-remaining'], '0');

      // Request 3: Blocked (HTTP 429)
      const resMem3 = await request(appMem).get('/api/test').set('X-Forwarded-For', clientIp);
      const resRedis3 = await request(appRedis).get('/api/test').set('X-Forwarded-For', clientIp);

      assert.equal(resMem3.status, 429);
      assert.equal(resRedis3.status, 429);
      assert.equal(resMem3.headers['ratelimit-remaining'], '0');
      assert.equal(resRedis3.headers['ratelimit-remaining'], '0');
      assert.equal(resMem3.headers['retry-after'], resRedis3.headers['retry-after']);
      assert.equal(resMem3.headers['ratelimit-reset'], resRedis3.headers['ratelimit-reset']);
      assert.equal(resMem3.headers['ratelimit-reset'], resMem3.headers['retry-after']);
    });
  });

  describe('2. Multi-Instance Shared Token Bucket (Distributed Redis)', () => {
    it('enforces a shared Token Bucket across multiple Express instances with zero local leaks', async () => {
      const sharedRedisClient = createDistributedRedisClient();
      const store = new RedisStore({ client: sharedRedisClient });

      const limiter = rateLimiter({
        algorithm: 'token-bucket',
        capacity: 4,
        refillRate: 1,
        refillIntervalMs: 1000,
        store
      });

      const appA = createExpressApp();
      appA.get('/api/shared', limiter, (req, res) => res.json({ instance: 'A' }));

      const appB = createExpressApp();
      appB.get('/api/shared', limiter, (req, res) => res.json({ instance: 'B' }));

      const clientIp = '198.51.100.42';

      // Interleave requests across Instance A and Instance B
      // Req 1 -> App A
      const res1 = await request(appA).get('/api/shared').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '3');

      // Req 2 -> App B
      const res2 = await request(appB).get('/api/shared').set('X-Forwarded-For', clientIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '2');

      // Req 3 -> App A
      const res3 = await request(appA).get('/api/shared').set('X-Forwarded-For', clientIp);
      assert.equal(res3.status, 200);
      assert.equal(res3.headers['ratelimit-remaining'], '1');

      // Req 4 -> App B (last token consumed)
      const res4 = await request(appB).get('/api/shared').set('X-Forwarded-For', clientIp);
      assert.equal(res4.status, 200);
      assert.equal(res4.headers['ratelimit-remaining'], '0');

      // Req 5 -> App A is BLOCKED with 429
      const res5 = await request(appA).get('/api/shared').set('X-Forwarded-For', clientIp);
      assert.equal(res5.status, 429);
      assert.equal(res5.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res5.headers['retry-after']) >= 1);

      // Req 6 -> App B is ALSO BLOCKED with 429
      const res6 = await request(appB).get('/api/shared').set('X-Forwarded-For', clientIp);
      assert.equal(res6.status, 429);
      assert.equal(res6.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res6.headers['retry-after']) >= 1);
    });
  });

  describe('3. Identity Composition with Token Bucket (User, API Key, Tenant, IP Fallback)', () => {
    it('isolates Token Bucket quotas by authenticated User ID behind a shared NAT IP', async () => {
      const app = createExpressApp();
      // Middleware simulating authentication populating req.user
      app.use((req, res, next) => {
        const userId = req.headers['x-user-id'];
        if (userId) req.user = { id: userId };
        next();
      });

      app.get(
        '/api/profile',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 1,
          keyGenerator: (req) => req.user?.id
        }),
        (req, res) => res.json({ profile: req.user?.id })
      );

      const sharedNatIp = '198.51.100.99';

      // Alice drains her bucket
      await request(app).get('/api/profile').set('X-Forwarded-For', sharedNatIp).set('X-User-Id', 'alice');
      await request(app).get('/api/profile').set('X-Forwarded-For', sharedNatIp).set('X-User-Id', 'alice');
      const aliceBlocked = await request(app).get('/api/profile').set('X-Forwarded-For', sharedNatIp).set('X-User-Id', 'alice');
      assert.equal(aliceBlocked.status, 429);

      // Bob behind the exact same NAT IP is unaffected and has full quota
      const bobRes = await request(app).get('/api/profile').set('X-Forwarded-For', sharedNatIp).set('X-User-Id', 'bob');
      assert.equal(bobRes.status, 200);
      assert.equal(bobRes.headers['ratelimit-remaining'], '1');
    });

    it('isolates Token Bucket quotas by API Key', async () => {
      const app = createExpressApp();
      app.get(
        '/api/v1/data',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 1,
          keyGenerator: (req) => req.headers['x-api-key']
        }),
        (req, res) => res.json({ data: 'ok' })
      );

      // Key 1 exhausted
      await request(app).get('/api/v1/data').set('X-Api-Key', 'key_alpha');
      await request(app).get('/api/v1/data').set('X-Api-Key', 'key_alpha');
      const key1Blocked = await request(app).get('/api/v1/data').set('X-Api-Key', 'key_alpha');
      assert.equal(key1Blocked.status, 429);

      // Key 2 has full quota
      const key2Allowed = await request(app).get('/api/v1/data').set('X-Api-Key', 'key_beta');
      assert.equal(key2Allowed.status, 200);
      assert.equal(key2Allowed.headers['ratelimit-remaining'], '1');
    });

    it('supports multi-tenant composite keys in Token Bucket', async () => {
      const app = createExpressApp();
      app.use((req, res, next) => {
        req.user = { id: req.headers['x-user-id'] };
        next();
      });

      app.get(
        '/api/tenant-resource',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 1,
          keyGenerator: (req) => `${req.headers['x-tenant-id']}:${req.user?.id}`
        }),
        (req, res) => res.json({ ok: true })
      );

      // Tenant 1 User 1 exhausted
      await request(app).get('/api/tenant-resource').set('X-Tenant-Id', 'tenant_1').set('X-User-Id', 'usr_1');
      await request(app).get('/api/tenant-resource').set('X-Tenant-Id', 'tenant_1').set('X-User-Id', 'usr_1');
      const t1u1Blocked = await request(app).get('/api/tenant-resource').set('X-Tenant-Id', 'tenant_1').set('X-User-Id', 'usr_1');
      assert.equal(t1u1Blocked.status, 429);

      // Tenant 2 User 1 (same user ID in different tenant) is independent and allowed
      const t2u1Allowed = await request(app).get('/api/tenant-resource').set('X-Tenant-Id', 'tenant_2').set('X-User-Id', 'usr_1');
      assert.equal(t2u1Allowed.status, 200);
      assert.equal(t2u1Allowed.headers['ratelimit-remaining'], '1');
    });

    it('falls back gracefully to IP when keyGenerator returns null, undefined, or empty string', async () => {
      const app = createExpressApp();
      app.get(
        '/api/fallback',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 1,
          keyGenerator: (req) => {
            if (req.headers['x-null']) return null;
            if (req.headers['x-empty']) return '   ';
            return req.headers['x-api-key']; // undefined if missing
          }
        }),
        (req, res) => res.json({ ok: true })
      );

      const clientIp = '192.168.4.10';

      // 1. Request without header (undefined) -> falls back to clientIp
      const res1 = await request(app).get('/api/fallback').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '1');

      // 2. Request with explicit null -> falls back to clientIp
      const res2 = await request(app).get('/api/fallback').set('X-Forwarded-For', clientIp).set('X-Null', 'true');
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      // 3. Request with empty whitespace string -> falls back to clientIp -> now blocked
      const res3 = await request(app).get('/api/fallback').set('X-Forwarded-For', clientIp).set('X-Empty', 'true');
      assert.equal(res3.status, 429);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });

    it('forwards keyGenerator errors to Express next(err) without unhandled rejection', async () => {
      const app = createExpressApp();
      app.get(
        '/api/error-route',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 1,
          keyGenerator: () => {
            throw new Error('Key extraction exploded');
          }
        }),
        (req, res) => res.json({ ok: true })
      );

      // Custom error handler to catch next(err)
      app.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(app).get('/api/error-route');
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'Key extraction exploded');
    });
  });

  describe('4. HTTP Client Recovery Flow (200 -> 429 -> Sleep Retry-After -> 200)', () => {
    it('allows burst up to capacity, blocks with 429, and recovers to 200 OK after waiting', async () => {
      const app = createExpressApp();
      // Configure rapid refill: 20 tokens per second (1 token every 50ms)
      app.get(
        '/api/rapid-resource',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 2,
          refillRate: 20,
          refillIntervalMs: 1000
        }),
        (req, res) => res.json({ success: true, timestamp: Date.now() })
      );

      const clientIp = '10.200.0.1';

      // 1. Initial burst: Request 1 (Allowed)
      const res1 = await request(app).get('/api/rapid-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '1');

      // 2. Initial burst: Request 2 (Allowed)
      const res2 = await request(app).get('/api/rapid-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      // 3. Immediate Request 3: Blocked (HTTP 429)
      const res3 = await request(app).get('/api/rapid-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.body.success, false);
      assert.equal(res3.body.message, 'Too many requests');
      assert.ok(Number(res3.headers['retry-after']) >= 1);
      assert.equal(res3.headers['ratelimit-reset'], res3.headers['retry-after']);

      // 4. Wait for token to refill (>50ms, wait 70ms)
      await new Promise((resolve) => setTimeout(resolve, 70));

      // 5. Retried Request 4: Recovered (HTTP 200 OK)
      const res4 = await request(app).get('/api/rapid-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res4.status, 200);
      assert.equal(res4.body.success, true);
      assert.equal(res4.headers['ratelimit-remaining'], '0');
    });
  });

  describe('5. Concurrency & Atomicity Verification under V5 Semantics', () => {
    it('verifies that 50 concurrent requests enforce exact capacity quota under RedisStore', async () => {
      const redisClient = createDistributedRedisClient();
      const store = new RedisStore({ client: redisClient });

      const app = createExpressApp();
      app.get(
        '/api/concurrent',
        rateLimiter({
          algorithm: 'token-bucket',
          capacity: 10,
          refillRate: 1,
          refillIntervalMs: 1000,
          store
        }),
        (req, res) => res.json({ ok: true })
      );

      const clientIp = '10.99.88.77';

      // Fire 50 requests simultaneously
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          request(app).get('/api/concurrent').set('X-Forwarded-For', clientIp)
        )
      );

      const allowedResponses = results.filter((r) => r.status === 200);
      const blockedResponses = results.filter((r) => r.status === 429);

      // Quota integrity: exactly 10 allowed, 40 blocked
      assert.equal(allowedResponses.length, 10);
      assert.equal(blockedResponses.length, 40);

      // All 429 responses must have Option C reset === retryAfter
      for (const blocked of blockedResponses) {
        assert.equal(blocked.headers['ratelimit-remaining'], '0');
        assert.ok(Number(blocked.headers['retry-after']) >= 1);
        assert.equal(blocked.headers['ratelimit-reset'], blocked.headers['retry-after']);
      }
    });
  });
});
