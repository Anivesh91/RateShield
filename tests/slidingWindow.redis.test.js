import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter } from '../src/index.js';
import { RedisStore } from '../src/stores/redisStore.js';

/**
 * Creates a simulated Redis client supporting both Fixed Window strings and Sliding Window ZSETs.
 * Models Redis's non-interleaving Lua script execution guarantees.
 */
function createSimulatedRedisClient() {
  const zsets = new Map(); // key -> Array<{ score: number, member: string }>
  const strings = new Map(); // key -> { count: number, expiresAt: number }

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

        // 1. ZREMRANGEBYSCORE: Prune expired entries (score <= cutoff)
        entries = entries.filter((e) => e.score > cutoff);

        const currentCount = entries.length;
        let allowed = 0;

        if (currentCount < limit) {
          // 2. ZADD: Add request with score = now and unique member
          entries.push({ score: now, member });
          allowed = 1;
        }

        zsets.set(key, entries);

        // 3. ZRANGE 0 0 WITHSCORES: Find oldest active timestamp
        const oldestScore = entries.length > 0 ? entries[0].score : now;

        return [allowed, entries.length, oldestScore];
      }

      // Fixed Window Lua simulation
      const windowMs = Number(options.arguments[0]);
      const now = Date.now();
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

    async sendCommand(args) {
      if (args[0] === 'EVAL') {
        const key = args[3];
        const scriptArgs = args.slice(4);
        return this.eval(null, { keys: [key], arguments: scriptArgs });
      }
      return 'OK';
    },

    getZsetEntries(key) {
      return zsets.get(key) || [];
    }
  };
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v3 — Redis Sliding Window Tests', () => {

  it('allows initial requests and enforces quota boundary (1..N allowed, N+1 blocked)', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const key = 'smartrate:sliding-window:GET:/test:10.0.0.1';
    const limit = 3;
    const windowMs = 60_000;
    const t0 = 100_000;

    // Request 1: Allowed, remaining = 2
    const r1 = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 });
    assert.equal(r1.allowed, true);
    assert.equal(r1.count, 1);
    assert.equal(r1.remaining, 2);
    assert.ok(r1.reset > 0);

    // Request 2: Allowed, remaining = 1
    const r2 = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 1000 });
    assert.equal(r2.allowed, true);
    assert.equal(r2.count, 2);
    assert.equal(r2.remaining, 1);

    // Request 3: Allowed, remaining = 0 (exact limit reached)
    const r3 = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 2000 });
    assert.equal(r3.allowed, true);
    assert.equal(r3.count, 3);
    assert.equal(r3.remaining, 0);

    // Request 4: Blocked with HTTP 429
    const r4 = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 3000 });
    assert.equal(r4.allowed, false);
    assert.equal(r4.count, 3);
    assert.equal(r4.remaining, 0);
    assert.ok(r4.retryAfter > 0);
  });

  it('enforces exact half-open interval cutoff boundary (now - windowMs, now]', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const key = 'smartrate:sliding-window:GET:/cutoff:10.0.0.2';
    const limit = 2;
    const windowMs = 10_000;

    // Req 1 at t = 10_000
    await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 10_000 });
    // Req 2 at t = 15_000 (quota exhausted)
    await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 15_000 });

    // Blocked at t = 18_000
    const blocked = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 18_000 });
    assert.equal(blocked.allowed, false);

    // At t = 20_000: cutoff = 10_000.
    // The timestamp 10_000 is <= cutoff, so it is pruned by ZREMRANGEBYSCORE.
    // Exactly 1 slot opens up!
    const recovered = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 20_000 });
    assert.equal(recovered.allowed, true);
    assert.equal(recovered.count, 2); // 15_000 and 20_000 are in the active window
    assert.equal(recovered.remaining, 0);
  });

  it('ensures collision-resistant unique ZSET members for same-millisecond requests', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const key = 'smartrate:sliding-window:POST:/concurrent:10.0.0.3';
    const limit = 5;
    const windowMs = 60_000;
    const sameTimestamp = 1727181000000;

    // Send 3 requests with the exact same millisecond timestamp
    const resA = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: sameTimestamp });
    const resB = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: sameTimestamp });
    const resC = await redisStore.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: sameTimestamp });

    assert.equal(resA.allowed, true);
    assert.equal(resB.allowed, true);
    assert.equal(resC.allowed, true);

    // Verify all 3 entries exist in the ZSET with unique member identifiers
    const entries = redisClient.getZsetEntries(key);
    assert.equal(entries.length, 3, 'Expected 3 distinct ZSET members despite identical scores');

    const members = entries.map((e) => e.member);
    const uniqueMembers = new Set(members);
    assert.equal(uniqueMembers.size, 3, 'All ZSET members must be unique to prevent collisions');
  });

  it('isolates state between Fixed Window and Sliding Window algorithms on the same route and IP', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const app = createTestApp();
    const fixedLimiter = rateLimiter({ algorithm: 'fixed-window', limit: 1, windowMs: 60_000, store: redisStore });
    const slidingLimiter = rateLimiter({ algorithm: 'sliding-window', limit: 1, windowMs: 60_000, store: redisStore });

    app.get('/api/algo-test', (req, res, next) => {
      if (req.query.algo === 'sliding') return slidingLimiter(req, res, next);
      return fixedLimiter(req, res, next);
    }, (req, res) => res.json({ success: true }));

    const clientIp = '10.0.0.99';

    // Exhaust Fixed Window quota
    const f1 = await request(app).get('/api/algo-test?algo=fixed').set('X-Forwarded-For', clientIp);
    assert.equal(f1.status, 200);

    const f2 = await request(app).get('/api/algo-test?algo=fixed').set('X-Forwarded-For', clientIp);
    assert.equal(f2.status, 429);

    // Sliding Window on same route and IP must have independent fresh quota!
    const s1 = await request(app).get('/api/algo-test?algo=sliding').set('X-Forwarded-For', clientIp);
    assert.equal(s1.status, 200);

    const s2 = await request(app).get('/api/algo-test?algo=sliding').set('X-Forwarded-For', clientIp);
    assert.equal(s2.status, 429);
  });

  it('sets accurate RateLimit and Retry-After headers on Express routes', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const app = createTestApp();
    app.get(
      '/api/redis-sliding',
      rateLimiter({ algorithm: 'sliding-window', limit: 2, windowMs: 60_000, store: redisStore }),
      (req, res) => res.json({ success: true })
    );

    const clientIp = '172.16.0.10';

    const res1 = await request(app).get('/api/redis-sliding').set('X-Forwarded-For', clientIp);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers['ratelimit-limit'], '2');
    assert.equal(res1.headers['ratelimit-remaining'], '1');
    assert.ok(Number(res1.headers['ratelimit-reset']) > 0);

    const res2 = await request(app).get('/api/redis-sliding').set('X-Forwarded-For', clientIp);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers['ratelimit-remaining'], '0');

    const res3 = await request(app).get('/api/redis-sliding').set('X-Forwarded-For', clientIp);
    assert.equal(res3.status, 429);
    assert.equal(res3.body.success, false);
    assert.equal(res3.headers['ratelimit-remaining'], '0');
    assert.ok(Number(res3.headers['retry-after']) > 0);
  });
});
