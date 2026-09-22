import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { rateLimiter } from '../src/index.js';
import demoRoutes from '../examples/express-demo/routes.js';
import { cleanupExpiredRecords } from '../src/limiter/rateLimiter.js';

/**
 * Helper to build an Express app configured with trust proxy for test-only IP spoofing.
 * Production/demo app keeps its own configuration without hardcoded trust proxy.
 */
function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v1 — Test Suite', () => {

  describe('Option Validation (Fail-Fast)', () => {
    it('throws RangeError when limit is 0, negative, or not an integer', () => {
      assert.throws(() => rateLimiter({ limit: 0, windowMs: 60000 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: -5, windowMs: 60000 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: '5', windowMs: 60000 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5.5, windowMs: 60000 }), { name: 'RangeError' });
    });

    it('throws RangeError when windowMs is 0, negative, or non-finite', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 0 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: -100 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: Infinity }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: '60000' }), { name: 'RangeError' });
    });

    it('throws TypeError when options is not an object', () => {
      assert.throws(() => rateLimiter(null), { name: 'TypeError' });
    });
  });

  describe('Fixed Window Enforcement & Boundary Handling', () => {
    it('allows requests 1 through N (first allowed, exactly N allowed) and blocks N+1 with 429', async () => {
      const app = createTestApp();
      app.get(
        '/test-boundary',
        rateLimiter({ limit: 5, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '192.168.1.50';

      // Requests 1 through 5 must all succeed (200 OK)
      for (let i = 1; i <= 5; i++) {
        const response = await request(app)
          .get('/test-boundary')
          .set('X-Forwarded-For', testIp);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.headers['ratelimit-limit'], '5');
        assert.equal(response.headers['ratelimit-remaining'], String(5 - i));
        assert.ok(Number(response.headers['ratelimit-reset']) > 0);
      }

      // Request 6 (N+1) must return HTTP 429 Too Many Requests
      const blockedResponse = await request(app)
        .get('/test-boundary')
        .set('X-Forwarded-For', testIp);

      assert.equal(blockedResponse.status, 429);
      assert.equal(blockedResponse.body.success, false);
      assert.equal(blockedResponse.body.message, 'Too many requests');
      assert.ok(Number(blockedResponse.body.retryAfter) > 0);

      // Verify blocked response headers
      assert.equal(blockedResponse.headers['ratelimit-limit'], '5');
      assert.equal(blockedResponse.headers['ratelimit-remaining'], '0');
      assert.ok(Number(blockedResponse.headers['retry-after']) > 0);
    });

    it('ensures remaining header never drops below 0 across multiple blocked requests', async () => {
      const app = createTestApp();
      app.get(
        '/test-negative-guard',
        rateLimiter({ limit: 1, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '192.168.1.51';

      // Request 1: Allowed (Remaining = 0)
      const res1 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '0');

      // Subsequent blocked requests must stay at '0', never '-1'
      const res2 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 429);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      const res3 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });
  });

  describe('Isolation: IP, Route & HTTP Method', () => {
    it('isolates rate-limit buckets between different client IPs on the same route', async () => {
      const app = createTestApp();
      app.get(
        '/api/shared-endpoint',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const ipA = '172.16.10.1';
      const ipB = '172.16.10.2';

      // IP A uses full quota
      await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipA);
      await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipA);
      const ipABlocked = await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipA);
      assert.equal(ipABlocked.status, 429);

      // IP B accesses the same route and must be allowed with fresh quota!
      const ipBResponse = await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipB);
      assert.equal(ipBResponse.status, 200);
      assert.equal(ipBResponse.headers['ratelimit-remaining'], '1');
    });

    it('isolates counters between different HTTP methods on the exact same route path', async () => {
      const app = createTestApp();
      const limiter = rateLimiter({ limit: 2, windowMs: 60_000 });

      app.get('/api/users', limiter, (req, res) => res.json({ method: 'GET' }));
      app.post('/api/users', limiter, (req, res) => res.json({ method: 'POST' }));

      const clientIp = '10.99.0.1';

      // 1. Exhaust GET /api/users quota (2 requests)
      await request(app).get('/api/users').set('X-Forwarded-For', clientIp);
      await request(app).get('/api/users').set('X-Forwarded-For', clientIp);
      const getBlocked = await request(app).get('/api/users').set('X-Forwarded-For', clientIp);
      assert.equal(getBlocked.status, 429);

      // 2. Immediately call POST /api/users with the SAME IP -> must succeed!
      const postResponse = await request(app).post('/api/users').set('X-Forwarded-For', clientIp);
      assert.equal(postResponse.status, 200);
      assert.equal(postResponse.headers['ratelimit-remaining'], '1');
    });

    it('isolates counters between different route paths for the same client IP', async () => {
      // Create a test app with trust proxy using the demo router logic
      const app = createTestApp();
      app.use('/api', demoRoutes);

      const testIp = '10.99.0.2';

      // Exhaust /api/login quota (limit: 3)
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/login').set('X-Forwarded-For', testIp);
        assert.equal(res.status, 200);
      }
      const loginBlocked = await request(app).post('/api/login').set('X-Forwarded-For', testIp);
      assert.equal(loginBlocked.status, 429);

      // /api/test (limit: 5) for the same IP must remain unaffected!
      const testRes = await request(app).get('/api/test').set('X-Forwarded-For', testIp);
      assert.equal(testRes.status, 200);
      assert.equal(testRes.headers['ratelimit-remaining'], '4');
    });

    it('strips query parameters so requests map to the same route counter', async () => {
      const app = createTestApp();
      app.get(
        '/api/products',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.99.0.3';

      await request(app).get('/api/products?page=1').set('X-Forwarded-For', testIp);
      await request(app).get('/api/products?page=2').set('X-Forwarded-For', testIp);

      const res3 = await request(app).get('/api/products?page=3').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
    });
  });

  describe('Window Expiration, Reset & Stale Entry Cleanup', () => {
    it('resets request counter and allows requests again once the window duration elapses', async () => {
      const app = createTestApp();
      app.get(
        '/test-expiry',
        rateLimiter({ limit: 1, windowMs: 100 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.99.0.4';

      const res1 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);

      const res2 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 429);

      // Wait 120ms for window to elapse
      await new Promise((resolve) => setTimeout(resolve, 120));

      const res3 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 200);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });

    it('actually evicts expired records from the in-memory Map', async () => {
      const app = createTestApp();
      app.get(
        '/test-cleanup',
        rateLimiter({ limit: 2, windowMs: 50 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.99.0.5';

      // Insert record
      await request(app).get('/test-cleanup').set('X-Forwarded-For', testIp);

      // Wait 60ms for window to elapse
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Trigger cleanup and verify it returns the number of evicted entries
      const removedCount = cleanupExpiredRecords();
      assert.ok(removedCount >= 1, `Expected at least 1 record removed, got: ${removedCount}`);
    });
  });

  describe('Demo Endpoints Verification', () => {
    it('enforces route-specific policy of 10 requests on /api/public', async () => {
      const app = createTestApp();
      app.use('/api', demoRoutes);

      const testIp = '10.99.0.6';

      for (let i = 1; i <= 10; i++) {
        const res = await request(app).get('/api/public').set('X-Forwarded-For', testIp);
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-remaining'], String(10 - i));
      }

      const blocked = await request(app).get('/api/public').set('X-Forwarded-For', testIp);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers['ratelimit-remaining'], '0');
      assert.ok(Number(blocked.headers['retry-after']) > 0);
    });
  });
});
