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

/**
 * Creates a simulated Redis client supporting both fixed and sliding window.
 */
function createSimulatedRedisClient() {
  const strings = new Map();
  const zsets = new Map();

  return {
    async eval(script, options) {
      const key = options.keys[0];

      // Sliding Window simulation
      if (options.arguments.length >= 4) {
        const now = Number(options.arguments[0]);
        const windowMs = Number(options.arguments[1]);
        const limit = Number(options.arguments[2]);
        const member = options.arguments[3];

        const cutoff = now - windowMs;
        let entries = zsets.get(key) || [];
        entries = entries.filter((e) => e.score > cutoff);

        let allowed = 0;
        if (entries.length < limit) {
          entries.push({ score: now, member });
          allowed = 1;
        }

        zsets.set(key, entries);
        const oldestScore = entries.length > 0 ? entries[0].score : now;
        return [allowed, entries.length, oldestScore];
      }

      // Fixed Window simulation
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

    async sendCommand() {
      return 'OK';
    }
  };
}

describe('SmartRate v4 — Custom Key Generator & Multi-Tenant Keys', () => {

  describe('Option Validation (Fail-Fast)', () => {
    it('throws TypeError when keyGenerator is provided but not a function', () => {
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 60_000, keyGenerator: 'invalid-string' }),
        {
          name: 'TypeError',
          message: /'keyGenerator' must be a function/
        }
      );

      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 60_000, keyGenerator: 12345 }),
        {
          name: 'TypeError',
          message: /'keyGenerator' must be a function/
        }
      );

      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 60_000, keyGenerator: {} }),
        {
          name: 'TypeError',
          message: /'keyGenerator' must be a function/
        }
      );
    });

    it('accepts valid synchronous and asynchronous keyGenerator functions', () => {
      const syncLimiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        keyGenerator: (req) => req.headers['x-api-key']
      });
      assert.equal(typeof syncLimiter, 'function');

      const asyncLimiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        keyGenerator: async (req) => Promise.resolve(req.headers['x-api-key'])
      });
      assert.equal(typeof asyncLimiter, 'function');
    });
  });

  describe('Default IP Identity (Backwards Compatibility)', () => {
    it('defaults to client IP when keyGenerator is omitted', async () => {
      const app = createTestApp();
      app.get(
        '/api/default-id',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.json({ success: true })
      );

      const ip1 = '192.168.10.1';
      const ip2 = '192.168.10.2';

      // Exhaust IP 1
      await request(app).get('/api/default-id').set('X-Forwarded-For', ip1);
      await request(app).get('/api/default-id').set('X-Forwarded-For', ip1);
      const blocked1 = await request(app).get('/api/default-id').set('X-Forwarded-For', ip1);
      assert.equal(blocked1.status, 429);

      // IP 2 must have full fresh quota
      const res2 = await request(app).get('/api/default-id').set('X-Forwarded-For', ip2);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '1');
    });
  });

  describe('User ID Identity & NAT/Shared-IP Isolation', () => {
    it('isolates different users sharing the exact same IP address', async () => {
      const app = createTestApp();

      // Middleware simulating authenticated session
      app.use((req, res, next) => {
        if (req.headers['authorization']) {
          req.user = { id: req.headers['authorization'].replace('Bearer ', '') };
        }
        next();
      });

      app.get(
        '/api/dashboard',
        rateLimiter({
          limit: 2,
          windowMs: 60_000,
          keyGenerator: (req) => `user:${req.user?.id || req.ip}`
        }),
        (req, res) => res.json({ success: true, user: req.user?.id })
      );

      const sharedOfficeIp = '203.0.113.195'; // Single public NAT IP

      // User Alice (user_alice) makes 2 requests -> Allowed
      const a1 = await request(app)
        .get('/api/dashboard')
        .set('X-Forwarded-For', sharedOfficeIp)
        .set('Authorization', 'Bearer user_alice');
      assert.equal(a1.status, 200);
      assert.equal(a1.headers['ratelimit-remaining'], '1');

      const a2 = await request(app)
        .get('/api/dashboard')
        .set('X-Forwarded-For', sharedOfficeIp)
        .set('Authorization', 'Bearer user_alice');
      assert.equal(a2.status, 200);
      assert.equal(a2.headers['ratelimit-remaining'], '0');

      // User Alice makes 3rd request -> Blocked 429
      const a3 = await request(app)
        .get('/api/dashboard')
        .set('X-Forwarded-For', sharedOfficeIp)
        .set('Authorization', 'Bearer user_alice');
      assert.equal(a3.status, 429);

      // User Bob (user_bob) on the SAME office IP makes requests -> Must NOT be blocked!
      const b1 = await request(app)
        .get('/api/dashboard')
        .set('X-Forwarded-For', sharedOfficeIp)
        .set('Authorization', 'Bearer user_bob');
      assert.equal(b1.status, 200, 'User Bob on same IP must receive independent quota');
      assert.equal(b1.headers['ratelimit-remaining'], '1');

      const b2 = await request(app)
        .get('/api/dashboard')
        .set('X-Forwarded-For', sharedOfficeIp)
        .set('Authorization', 'Bearer user_bob');
      assert.equal(b2.status, 200);
      assert.equal(b2.headers['ratelimit-remaining'], '0');

      const b3 = await request(app)
        .get('/api/dashboard')
        .set('X-Forwarded-For', sharedOfficeIp)
        .set('Authorization', 'Bearer user_bob');
      assert.equal(b3.status, 429);
    });
  });

  describe('API Key Identity', () => {
    it('enforces rate limits based on X-API-Key header', async () => {
      const app = createTestApp();
      app.get(
        '/v1/data',
        rateLimiter({
          limit: 3,
          windowMs: 60_000,
          keyGenerator: (req) => req.headers['x-api-key'] || req.ip
        }),
        (req, res) => res.json({ success: true })
      );

      const apiKeyA = 'sk_live_alpha_123';
      const apiKeyB = 'sk_live_bravo_456';

      // Exhaust API Key A
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/v1/data').set('X-API-Key', apiKeyA);
        assert.equal(res.status, 200);
      }
      const blockedA = await request(app).get('/v1/data').set('X-API-Key', apiKeyA);
      assert.equal(blockedA.status, 429);

      // API Key B is completely independent
      const resB = await request(app).get('/v1/data').set('X-API-Key', apiKeyB);
      assert.equal(resB.status, 200);
      assert.equal(resB.headers['ratelimit-remaining'], '2');
    });
  });

  describe('Multi-Tenant Isolation', () => {
    it('isolates tenants sharing the same user identifier format', async () => {
      const app = createTestApp();

      app.get(
        '/api/tenant-resource',
        rateLimiter({
          limit: 2,
          windowMs: 60_000,
          keyGenerator: (req) => {
            const tenant = req.headers['x-tenant-id'] || 'default-tenant';
            const user = req.headers['x-user-id'] || req.ip;
            return `tenant:${tenant}:user:${user}`;
          }
        }),
        (req, res) => res.json({ success: true })
      );

      // Same user identifier 'admin' in Tenant A vs Tenant B
      const tenantA = 'acme_corp';
      const tenantB = 'initech_corp';
      const userId = 'admin';

      // Exhaust Tenant A's admin
      await request(app)
        .get('/api/tenant-resource')
        .set('X-Tenant-ID', tenantA)
        .set('X-User-ID', userId);
      await request(app)
        .get('/api/tenant-resource')
        .set('X-Tenant-ID', tenantA)
        .set('X-User-ID', userId);

      const blockedTenantA = await request(app)
        .get('/api/tenant-resource')
        .set('X-Tenant-ID', tenantA)
        .set('X-User-ID', userId);
      assert.equal(blockedTenantA.status, 429);

      // Tenant B's admin must have independent quota despite same user ID
      const resTenantB = await request(app)
        .get('/api/tenant-resource')
        .set('X-Tenant-ID', tenantB)
        .set('X-User-ID', userId);
      assert.equal(resTenantB.status, 200);
      assert.equal(resTenantB.headers['ratelimit-remaining'], '1');
    });
  });

  describe('Fallback to IP when Identity is Missing', () => {
    it('gracefully falls back to IP when keyGenerator returns null, undefined, or empty string', async () => {
      const app = createTestApp();
      app.get(
        '/api/optional-auth',
        rateLimiter({
          limit: 2,
          windowMs: 60_000,
          keyGenerator: (req) => req.headers['x-api-key'] // Returns undefined for unauthenticated requests
        }),
        (req, res) => res.json({ success: true })
      );

      const publicIp1 = '198.51.100.1';
      const publicIp2 = '198.51.100.2';

      // Public client 1 (no API key header) exhausts quota
      await request(app).get('/api/optional-auth').set('X-Forwarded-For', publicIp1);
      await request(app).get('/api/optional-auth').set('X-Forwarded-For', publicIp1);

      const blocked = await request(app).get('/api/optional-auth').set('X-Forwarded-For', publicIp1);
      assert.equal(blocked.status, 429);

      // Public client 2 (different IP) has fresh quota
      const resIp2 = await request(app).get('/api/optional-auth').set('X-Forwarded-For', publicIp2);
      assert.equal(resIp2.status, 200);
    });
  });

  describe('Cross-Algorithm & Cross-Store Compatibility with Custom Keys', () => {
    it('works with Sliding Window algorithm and RedisStore', async () => {
      const redisClient = createSimulatedRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const app = createTestApp();
      app.get(
        '/api/redis-custom-key',
        rateLimiter({
          algorithm: 'sliding-window',
          limit: 2,
          windowMs: 60_000,
          store: redisStore,
          keyGenerator: (req) => `client:${req.headers['x-client-id'] || req.ip}`
        }),
        (req, res) => res.json({ success: true })
      );

      const clientA = 'mobile-app-client';
      const clientB = 'web-frontend-client';

      // Exhaust Client A on Redis Sliding Window
      await request(app).get('/api/redis-custom-key').set('X-Client-ID', clientA);
      await request(app).get('/api/redis-custom-key').set('X-Client-ID', clientA);

      const blockedA = await request(app).get('/api/redis-custom-key').set('X-Client-ID', clientA);
      assert.equal(blockedA.status, 429);

      // Client B on same route has fresh quota
      const resB = await request(app).get('/api/redis-custom-key').set('X-Client-ID', clientB);
      assert.equal(resB.status, 200);
      assert.equal(resB.headers['ratelimit-remaining'], '1');
    });
  });
});
