import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, MemoryStore, RedisStore } from '../src/index.js';

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

function createMockRedisClient() {
  const hashes = new Map();
  return {
    async eval(script, options) {
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
      let reset;
      if (allowed === 1) {
        const timeToFullMs = Math.max(0, (capacity - currentTokens) / refillPerMs);
        reset = Math.max(1, Math.ceil(timeToFullMs / 1000));
      } else {
        reset = retryAfter;
      }
      return [allowed, remaining, reset, retryAfter];
    },
    async sendCommand() {
      return 'OK';
    }
  };
}

describe('SmartRate v4 — Dynamic & Tier-Based Policy Tests', () => {

  describe('Tier-Based Limit & Quota Enforcement (Fixed Window)', () => {
    it('applies tier-dependent limits (Free: 3 reqs vs Pro: 10 reqs) and sets matching headers', async () => {
      const app = createTestApp();
      const store = new MemoryStore();

      app.get(
        '/api/resource',
        rateLimiter({
          store,
          keyGenerator: (req) => req.headers['x-api-key'],
          limit: (req) => {
            const tier = req.headers['x-tier'];
            if (tier === 'pro') return 10;
            return 3; // Free tier default
          },
          windowMs: 60_000
        }),
        (req, res) => res.status(200).json({ success: true, tier: req.headers['x-tier'] || 'free' })
      );

      // Free user: allowed 3 requests
      for (let i = 1; i <= 3; i++) {
        const res = await request(app)
          .get('/api/resource')
          .set('x-api-key', 'key_free_user')
          .set('x-tier', 'free');
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-limit'], '3');
        assert.equal(res.headers['ratelimit-remaining'], String(3 - i));
      }

      // 4th request from Free user blocked with 429
      const blockedFree = await request(app)
        .get('/api/resource')
        .set('x-api-key', 'key_free_user')
        .set('x-tier', 'free');
      assert.equal(blockedFree.status, 429);
      assert.equal(blockedFree.headers['ratelimit-limit'], '3');
      assert.equal(blockedFree.headers['ratelimit-remaining'], '0');

      // Pro user: allowed up to 10 requests independently
      for (let i = 1; i <= 8; i++) {
        const res = await request(app)
          .get('/api/resource')
          .set('x-api-key', 'key_pro_user')
          .set('x-tier', 'pro');
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-limit'], '10');
        assert.equal(res.headers['ratelimit-remaining'], String(10 - i));
      }
    });
  });

  describe('Tier-Based Limit & Quota Enforcement (Sliding Window)', () => {
    it('dynamically adapts rolling sliding window limits based on user role', async () => {
      const app = createTestApp();
      const store = new MemoryStore();

      app.get(
        '/api/sliding-tier',
        rateLimiter({
          store,
          algorithm: 'sliding-window',
          keyGenerator: (req) => req.headers['x-user-id'],
          limit: (req) => (req.headers['x-role'] === 'admin' ? 15 : 2),
          windowMs: 60_000
        }),
        (req, res) => res.status(200).json({ ok: true })
      );

      // Standard user: limit 2
      await request(app).get('/api/sliding-tier').set('x-user-id', 'u_std').set('x-role', 'user');
      await request(app).get('/api/sliding-tier').set('x-user-id', 'u_std').set('x-role', 'user');
      const stdBlocked = await request(app).get('/api/sliding-tier').set('x-user-id', 'u_std').set('x-role', 'user');
      assert.equal(stdBlocked.status, 429);

      // Admin user: limit 15
      for (let i = 0; i < 5; i++) {
        const adminRes = await request(app).get('/api/sliding-tier').set('x-user-id', 'u_adm').set('x-role', 'admin');
        assert.equal(adminRes.status, 200);
      }
    });
  });

  describe('Dynamic Token Bucket (Tier-Based Capacity & Refill)', () => {
    it('supports dynamic capacity and refillRate functions in MemoryStore', async () => {
      const app = createTestApp();
      const store = new MemoryStore();

      app.get(
        '/api/compute',
        rateLimiter({
          store,
          algorithm: 'token-bucket',
          keyGenerator: (req) => req.headers['x-tenant-id'],
          capacity: (req) => (req.headers['x-plan'] === 'enterprise' ? 10 : 3),
          refillRate: (req) => (req.headers['x-plan'] === 'enterprise' ? 5 : 1)
        }),
        (req, res) => res.status(200).json({ success: true })
      );

      // Tenant 1 (Standard): capacity 3
      for (let i = 1; i <= 3; i++) {
        const res = await request(app)
          .get('/api/compute')
          .set('x-tenant-id', 'tenant_std')
          .set('x-plan', 'standard');
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-limit'], '3');
      }

      const stdBlocked = await request(app)
        .get('/api/compute')
        .set('x-tenant-id', 'tenant_std')
        .set('x-plan', 'standard');
      assert.equal(stdBlocked.status, 429);

      // Tenant 2 (Enterprise): capacity 10
      for (let i = 1; i <= 10; i++) {
        const res = await request(app)
          .get('/api/compute')
          .set('x-tenant-id', 'tenant_ent')
          .set('x-plan', 'enterprise');
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-limit'], '10');
      }

      const entBlocked = await request(app)
        .get('/api/compute')
        .set('x-tenant-id', 'tenant_ent')
        .set('x-plan', 'enterprise');
      assert.equal(entBlocked.status, 429);
    });

    it('supports dynamic token bucket with RedisStore', async () => {
      const redisClient = createMockRedisClient();
      const redisStore = new RedisStore({ client: redisClient });
      const app = createTestApp();

      app.get(
        '/api/redis-tier',
        rateLimiter({
          store: redisStore,
          algorithm: 'token-bucket',
          keyGenerator: (req) => req.headers['x-client-id'],
          capacity: (req) => (req.headers['x-tier'] === 'vip' ? 5 : 2),
          refillRate: (req) => (req.headers['x-tier'] === 'vip' ? 2 : 1)
        }),
        (req, res) => res.status(200).json({ success: true })
      );

      // Basic client: capacity 2
      await request(app).get('/api/redis-tier').set('x-client-id', 'c_basic').set('x-tier', 'basic');
      await request(app).get('/api/redis-tier').set('x-client-id', 'c_basic').set('x-tier', 'basic');
      const blocked = await request(app).get('/api/redis-tier').set('x-client-id', 'c_basic').set('x-tier', 'basic');
      assert.equal(blocked.status, 429);

      // VIP client: capacity 5
      for (let i = 0; i < 5; i++) {
        const vipRes = await request(app).get('/api/redis-tier').set('x-client-id', 'c_vip').set('x-tier', 'vip');
        assert.equal(vipRes.status, 200);
      }
      const vipBlocked = await request(app).get('/api/redis-tier').set('x-client-id', 'c_vip').set('x-tier', 'vip');
      assert.equal(vipBlocked.status, 429);
    });
  });

  describe('Dynamic Weighted Request Cost', () => {
    it('charges variable token costs based on operation payload or query parameter', async () => {
      const app = createTestApp();
      const store = new MemoryStore();

      app.post(
        '/api/data-ops',
        rateLimiter({
          store,
          algorithm: 'token-bucket',
          capacity: 10,
          refillRate: 1,
          keyGenerator: (req) => req.headers['x-api-key'],
          cost: (req) => (req.body?.operation === 'bulk-export' ? 5 : 1)
        }),
        (req, res) => res.status(200).json({ processed: true })
      );

      const apiKey = 'client_weighted_test';

      // 1. Light operation costs 1 token: Remaining drops from 10 to 9
      const r1 = await request(app)
        .post('/api/data-ops')
        .set('x-api-key', apiKey)
        .send({ operation: 'single-read' });
      assert.equal(r1.status, 200);
      assert.equal(r1.headers['ratelimit-remaining'], '9');

      // 2. Heavy operation costs 5 tokens: Remaining drops from 9 to 4
      const r2 = await request(app)
        .post('/api/data-ops')
        .set('x-api-key', apiKey)
        .send({ operation: 'bulk-export' });
      assert.equal(r2.status, 200);
      assert.equal(r2.headers['ratelimit-remaining'], '4');

      // 3. Second heavy operation (costs 5 tokens) exceeds remaining 4 tokens -> Blocked 429!
      const r3 = await request(app)
        .post('/api/data-ops')
        .set('x-api-key', apiKey)
        .send({ operation: 'bulk-export' });
      assert.equal(r3.status, 429);
      assert.equal(r3.headers['ratelimit-remaining'], '4'); // Remaining tokens preserved
    });
  });

  describe('Dynamic Policy Error Handling & Edge Cases', () => {
    it('forwards RangeError to next(err) if dynamic limit resolves to invalid number', async () => {
      const app = createTestApp();
      app.get(
        '/api/invalid-limit',
        rateLimiter({
          limit: () => -5, // Invalid limit returned dynamically
          windowMs: 60_000
        }),
        (req, res) => res.json({ ok: true })
      );

      // Express error handling middleware
      app.use((err, req, res, next) => {
        res.status(500).json({ error: err.name, message: err.message });
      });

      const res = await request(app).get('/api/invalid-limit');
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'RangeError');
      assert.match(res.body.message, /must resolve to a positive integer/);
    });

    it('forwards error to next(err) if dynamic policy function throws', async () => {
      const app = createTestApp();
      app.get(
        '/api/throwing-policy',
        rateLimiter({
          limit: () => {
            throw new Error('Database tier lookup failed');
          },
          windowMs: 60_000
        }),
        (req, res) => res.json({ ok: true })
      );

      app.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(app).get('/api/throwing-policy');
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'Database tier lookup failed');
    });
  });

});
