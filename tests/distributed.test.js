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
  const store = new Map();
  let queue = Promise.resolve();

  return {
    async eval(script, options) {
      return new Promise((resolve) => {
        queue = queue.then(async () => {
          const key = options.keys[0];
          const windowMs = Number(options.arguments[0]);
          const now = Date.now();

          let entry = store.get(key);
          if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
            entry = { count: 1, expiresAt: now + windowMs };
            store.set(key, entry);
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

describe('SmartRate v2 — Distributed Multi-Instance Verification', () => {

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
