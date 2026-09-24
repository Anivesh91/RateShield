import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter } from '../src/index.js';
import { RedisStore } from '../src/stores/redisStore.js';

/**
 * Creates a shared simulated Redis client backing multiple app instances.
 */
function createSharedRedisClient() {
  const strings = new Map();
  const zsets = new Map();
  let queue = Promise.resolve();

  return {
    async eval(script, options) {
      return new Promise((resolve) => {
        queue = queue.then(async () => {
          const key = options.keys[0];

          // 1. Sliding Window Lua Execution (4 arguments: now, windowMs, limit, member)
          if (options.arguments.length >= 4) {
            const now = Number(options.arguments[0]);
            const windowMs = Number(options.arguments[1]);
            const limit = Number(options.arguments[2]);
            const member = options.arguments[3];

            const cutoff = now - windowMs;
            let entries = zsets.get(key) || [];

            // Prune expired entries outside rolling interval (cutoff < score <= now)
            entries = entries.filter((e) => e.score > cutoff);

            const currentCount = entries.length;
            let allowed = 0;

            if (currentCount < limit) {
              entries.push({ score: now, member });
              allowed = 1;
            }

            zsets.set(key, entries);

            const oldestScore = entries.length > 0 ? entries[0].score : now;
            resolve([allowed, entries.length, oldestScore]);
            return;
          }

          // 2. Fixed Window Lua Execution (1 argument: windowMs)
          const windowMs = Number(options.arguments[0]);
          const now = Date.now();

          let entry = strings.get(key);
          if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
            entry = { count: 1, expiresAt: now + windowMs };
            strings.set(key, entry);
            resolve([1, windowMs]);
            return;
          }

          entry.count += 1;
          const remainingTtl = Math.max(0, entry.expiresAt - now);
          resolve([entry.count, remainingTtl]);
        });
      });
    },

    async sendCommand() {
      return 'OK';
    }
  };
}

function createAppInstance(limiterMiddleware) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.get('/api/resource', limiterMiddleware, (req, res) => res.json({ success: true }));
  return app;
}

describe('SmartRate v2 — Distributed Multi-Instance Verification (Fixed Window)', () => {

  it('enforces a shared quota across two distinct Express application instances', async () => {
    const sharedRedisClient = createSharedRedisClient();

    // Both app instances configure rateLimiter with the same underlying Redis store
    const store = new RedisStore({ client: sharedRedisClient });
    const limiter = rateLimiter({ limit: 5, windowMs: 60_000, store });

    const appA = createAppInstance(limiter);
    const appB = createAppInstance(limiter);

    const clientIp = '192.168.1.100';

    // Interleave requests between App A and App B
    // Req 1 -> App A
    const res1 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers['ratelimit-remaining'], '4');

    // Req 2 -> App B
    const res2 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers['ratelimit-remaining'], '3');

    // Req 3 -> App A
    const res3 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res3.status, 200);
    assert.equal(res3.headers['ratelimit-remaining'], '2');

    // Req 4 -> App B
    const res4 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res4.status, 200);
    assert.equal(res4.headers['ratelimit-remaining'], '1');

    // Req 5 -> App A (Final allowed request)
    const res5 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res5.status, 200);
    assert.equal(res5.headers['ratelimit-remaining'], '0');

    // Req 6 -> App B must block with HTTP 429 even though App B only served 2 allowed requests!
    const res6 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res6.status, 429);
    assert.equal(res6.body.success, false);
    assert.equal(res6.headers['ratelimit-remaining'], '0');
    assert.ok(Number(res6.headers['retry-after']) > 0);
  });

  it('isolates different clients when accessing through different instances', async () => {
    const sharedRedisClient = createSharedRedisClient();
    const store = new RedisStore({ client: sharedRedisClient });
    const limiter = rateLimiter({ limit: 2, windowMs: 60_000, store });

    const appA = createAppInstance(limiter);
    const appB = createAppInstance(limiter);

    const clientA = '172.20.0.1';
    const clientB = '172.20.0.2';

    // Exhaust client A's quota using App A
    await request(appA).get('/api/resource').set('X-Forwarded-For', clientA);
    await request(appA).get('/api/resource').set('X-Forwarded-For', clientA);
    const blockedA = await request(appB).get('/api/resource').set('X-Forwarded-For', clientA);
    assert.equal(blockedA.status, 429);

    // Client B accessing App B must have a fresh quota
    const resB1 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientB);
    assert.equal(resB1.status, 200);
    assert.equal(resB1.headers['ratelimit-remaining'], '1');
  });
});

describe('SmartRate v3 — Distributed Multi-Instance Verification (Sliding Window)', () => {

  it('enforces a shared sliding window quota across two distinct Express application instances', async () => {
    const sharedRedisClient = createSharedRedisClient();
    const sharedStore = new RedisStore({ client: sharedRedisClient });

    const LIMIT = 4;
    const limiter = rateLimiter({
      algorithm: 'sliding-window',
      limit: LIMIT,
      windowMs: 60_000,
      store: sharedStore
    });

    const appA = createAppInstance(limiter);
    const appB = createAppInstance(limiter);

    const clientIp = '10.50.1.10';

    // Request 1 -> App A
    const res1 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers['ratelimit-limit'], String(LIMIT));
    assert.equal(res1.headers['ratelimit-remaining'], '3');

    // Request 2 -> App B
    const res2 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers['ratelimit-remaining'], '2');

    // Request 3 -> App A
    const res3 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res3.status, 200);
    assert.equal(res3.headers['ratelimit-remaining'], '1');

    // Request 4 -> App B (Last allowed request)
    const res4 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res4.status, 200);
    assert.equal(res4.headers['ratelimit-remaining'], '0');

    // Request 5 -> App A (Quota exhausted across instances -> blocked 429)
    const res5 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res5.status, 429);
    assert.equal(res5.body.success, false);
    assert.equal(res5.headers['ratelimit-remaining'], '0');
    assert.ok(Number(res5.headers['ratelimit-reset']) > 0);
    assert.ok(Number(res5.headers['retry-after']) > 0);

    // Request 6 -> App B (Also blocked 429)
    const res6 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientIp);
    assert.equal(res6.status, 429);
    assert.equal(res6.body.success, false);
    assert.equal(res6.headers['ratelimit-remaining'], '0');
    assert.ok(Number(res6.headers['retry-after']) > 0);
  });

  it('isolates different clients under distributed sliding window across instances', async () => {
    const sharedRedisClient = createSharedRedisClient();
    const sharedStore = new RedisStore({ client: sharedRedisClient });

    const limiter = rateLimiter({
      algorithm: 'sliding-window',
      limit: 2,
      windowMs: 60_000,
      store: sharedStore
    });

    const appA = createAppInstance(limiter);
    const appB = createAppInstance(limiter);

    const clientA = '10.50.2.1';
    const clientB = '10.50.2.2';

    // Exhaust client A across App A and App B
    await request(appA).get('/api/resource').set('X-Forwarded-For', clientA);
    await request(appB).get('/api/resource').set('X-Forwarded-For', clientA);

    const blockedA = await request(appA).get('/api/resource').set('X-Forwarded-For', clientA);
    assert.equal(blockedA.status, 429);

    // Client B must retain full independent quota
    const resB1 = await request(appB).get('/api/resource').set('X-Forwarded-For', clientB);
    assert.equal(resB1.status, 200);
    assert.equal(resB1.headers['ratelimit-remaining'], '1');

    const resB2 = await request(appA).get('/api/resource').set('X-Forwarded-For', clientB);
    assert.equal(resB2.status, 200);
    assert.equal(resB2.headers['ratelimit-remaining'], '0');
  });

  it('enforces shared quota under simultaneous concurrent load distributed across instances', async () => {
    const sharedRedisClient = createSharedRedisClient();
    const sharedStore = new RedisStore({ client: sharedRedisClient });

    const LIMIT = 6;
    const limiter = rateLimiter({
      algorithm: 'sliding-window',
      limit: LIMIT,
      windowMs: 60_000,
      store: sharedStore
    });

    const appA = createAppInstance(limiter);
    const appB = createAppInstance(limiter);

    const clientIp = '10.50.3.99';

    // Send 10 concurrent requests to App A and 10 concurrent requests to App B simultaneously
    const requestsA = Array.from({ length: 10 }, () =>
      request(appA).get('/api/resource').set('X-Forwarded-For', clientIp)
    );
    const requestsB = Array.from({ length: 10 }, () =>
      request(appB).get('/api/resource').set('X-Forwarded-For', clientIp)
    );

    const responses = await Promise.all([...requestsA, ...requestsB]);

    const allowed = responses.filter((r) => r.status === 200);
    const blocked = responses.filter((r) => r.status === 429);

    assert.equal(allowed.length, LIMIT, `Expected exactly ${LIMIT} allowed across both instances`);
    assert.equal(blocked.length, 20 - LIMIT, `Expected exactly ${20 - LIMIT} blocked across both instances`);

    for (const res of blocked) {
      assert.equal(res.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res.headers['retry-after']) > 0);
    }
  });
});
