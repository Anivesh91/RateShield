import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter } from '../src/index.js';
import { RedisStore } from '../src/stores/redisStore.js';

/**
 * Creates an in-memory Redis test client simulating INCR, PEXPIRE, and PTTL.
 * Maintains realistic millisecond TTL expiration semantics.
 */
function createSimulatedRedisClient() {
  const data = new Map();

  return {
    async incr(key) {
      const entry = data.get(key);
      const now = Date.now();

      if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
        data.set(key, { value: 1, expiresAt: null });
        return 1;
      }

      entry.value += 1;
      return entry.value;
    },

    async pExpire(key, ms) {
      const entry = data.get(key);
      if (!entry) return false;
      entry.expiresAt = Date.now() + ms;
      return true;
    },

    async pTTL(key) {
      const entry = data.get(key);
      if (!entry) return -2;
      if (!entry.expiresAt) return -1;

      const remaining = entry.expiresAt - Date.now();
      if (remaining <= 0) {
        data.delete(key);
        return -2;
      }
      return remaining;
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

describe('SmartRate v2 — Redis Fixed Window & Expiration Tests', () => {

  it('increments counter and sets TTL on first request', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const app = createTestApp();
    app.get(
      '/api/redis-test',
      rateLimiter({ limit: 3, windowMs: 60_000, store: redisStore }),
      (req, res) => res.json({ success: true })
    );

    const testIp = '10.0.0.1';

    // Request 1: Count = 1, Remaining = 2
    const res1 = await request(app).get('/api/redis-test').set('X-Forwarded-For', testIp);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers['ratelimit-limit'], '3');
    assert.equal(res1.headers['ratelimit-remaining'], '2');
    assert.ok(Number(res1.headers['ratelimit-reset']) > 0);

    // Request 2: Count = 2, Remaining = 1
    const res2 = await request(app).get('/api/redis-test').set('X-Forwarded-For', testIp);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers['ratelimit-remaining'], '1');

    // Request 3: Count = 3, Remaining = 0 (exact limit reached)
    const res3 = await request(app).get('/api/redis-test').set('X-Forwarded-For', testIp);
    assert.equal(res3.status, 200);
    assert.equal(res3.headers['ratelimit-remaining'], '0');

    // Request 4: N+1 -> Blocked with HTTP 429
    const res4 = await request(app).get('/api/redis-test').set('X-Forwarded-For', testIp);
    assert.equal(res4.status, 429);
    assert.equal(res4.body.success, false);
    assert.equal(res4.body.message, 'Too many requests');
    assert.equal(res4.headers['ratelimit-remaining'], '0');
    assert.ok(Number(res4.headers['retry-after']) > 0);
  });

  it('resets counter and allows requests again once Redis TTL expires', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const app = createTestApp();
    app.get(
      '/api/redis-expiry',
      rateLimiter({ limit: 1, windowMs: 50, store: redisStore }),
      (req, res) => res.json({ success: true })
    );

    const testIp = '10.0.0.2';

    // Request 1: Allowed
    const res1 = await request(app).get('/api/redis-expiry').set('X-Forwarded-For', testIp);
    assert.equal(res1.status, 200);

    // Request 2: Blocked within active window
    const res2 = await request(app).get('/api/redis-expiry').set('X-Forwarded-For', testIp);
    assert.equal(res2.status, 429);

    // Wait 60ms for Redis TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Request 3: After TTL expiration, key was deleted by Redis -> Fresh window starts!
    const res3 = await request(app).get('/api/redis-expiry').set('X-Forwarded-For', testIp);
    assert.equal(res3.status, 200);
    assert.equal(res3.headers['ratelimit-remaining'], '0');
  });

  it('isolates counters between different HTTP methods on RedisStore', async () => {
    const redisClient = createSimulatedRedisClient();
    const redisStore = new RedisStore({ client: redisClient });
    const limiter = rateLimiter({ limit: 1, windowMs: 60_000, store: redisStore });

    const app = createTestApp();
    app.get('/api/resource', limiter, (req, res) => res.json({ method: 'GET' }));
    app.post('/api/resource', limiter, (req, res) => res.json({ method: 'POST' }));

    const testIp = '10.0.0.3';

    // Exhaust GET quota
    const getRes = await request(app).get('/api/resource').set('X-Forwarded-For', testIp);
    assert.equal(getRes.status, 200);

    const getBlocked = await request(app).get('/api/resource').set('X-Forwarded-For', testIp);
    assert.equal(getBlocked.status, 429);

    // POST on same route must be unaffected
    const postRes = await request(app).post('/api/resource').set('X-Forwarded-For', testIp);
    assert.equal(postRes.status, 200);
  });
});
