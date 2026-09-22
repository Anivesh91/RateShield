import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { rateLimiter } from '../src/index.js';
import demoApp from '../examples/express-demo/app.js';
import { cleanupExpiredRecords } from '../src/limiter/rateLimiter.js';

describe('SmartRate — Fixed Window Rate Limiter Suite', () => {

  describe('Part 1: Option Validation (Fail-Fast)', () => {
    it('throws RangeError when limit is 0, negative, or not an integer', () => {
      assert.throws(
        () => rateLimiter({ limit: 0, windowMs: 60000 }),
        { name: 'RangeError' }
      );
      assert.throws(
        () => rateLimiter({ limit: -5, windowMs: 60000 }),
        { name: 'RangeError' }
      );
      assert.throws(
        () => rateLimiter({ limit: '5', windowMs: 60000 }),
        { name: 'RangeError' }
      );
      assert.throws(
        () => rateLimiter({ limit: 5.5, windowMs: 60000 }),
        { name: 'RangeError' }
      );
    });

    it('throws RangeError when windowMs is 0, negative, or non-finite', () => {
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 0 }),
        { name: 'RangeError' }
      );
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: -100 }),
        { name: 'RangeError' }
      );
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: Infinity }),
        { name: 'RangeError' }
      );
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: '60000' }),
        { name: 'RangeError' }
      );
    });

    it('throws TypeError when options is not an object', () => {
      assert.throws(
        () => rateLimiter(null),
        { name: 'TypeError' }
      );
    });
  });

  describe('Part 2: Fixed Window Enforcement & Boundary Handling', () => {
    it('allows requests 1 through 5 and blocks request 6 with HTTP 429', async () => {
      const app = express();
      app.get(
        '/test-limit',
        rateLimiter({ limit: 5, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      // Unique IP to ensure isolated test state
      const testIp = '10.0.0.1';

      // Requests 1 through 5 must all succeed (200 OK)
      for (let i = 1; i <= 5; i++) {
        const response = await request(app)
          .get('/test-limit')
          .set('X-Forwarded-For', testIp);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.headers['ratelimit-limit'], '5');
        assert.equal(response.headers['ratelimit-remaining'], String(5 - i));
        assert.ok(Number(response.headers['ratelimit-reset']) > 0);
      }

      // Request 6 must be blocked with HTTP 429
      const blockedResponse = await request(app)
        .get('/test-limit')
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

    it('remaining header never drops below 0 on multiple blocked requests', async () => {
      const app = express();
      app.get(
        '/test-negative-guard',
        rateLimiter({ limit: 1, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.0.0.2';

      // Request 1: Allowed (Remaining = 0)
      const res1 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '0');

      // Request 2 & 3: Blocked (Remaining must stay '0', never '-1')
      const res2 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 429);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      const res3 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });
  });

  describe('Part 3: Route Isolation on Shared Map', () => {
    it('tracks limits independently for different routes from the same IP', async () => {
      const testIp = '10.0.0.3';

      // 1. Exhaust /api/login quota (Limit: 3 requests / 60s)
      for (let i = 0; i < 3; i++) {
        const res = await request(demoApp)
          .post('/api/login')
          .set('X-Forwarded-For', testIp);
        assert.equal(res.status, 200);
      }

      // 4th login attempt must be 429 blocked
      const loginBlocked = await request(demoApp)
        .post('/api/login')
        .set('X-Forwarded-For', testIp);
      assert.equal(loginBlocked.status, 429);

      // 2. Immediately call /api/test (Limit: 5 requests / 60s) with same IP
      // It MUST succeed because /test has its own independent counter!
      const testResponse = await request(demoApp)
        .get('/api/test')
        .set('X-Forwarded-For', testIp);

      assert.equal(testResponse.status, 200);
      assert.equal(testResponse.body.message, 'Test endpoint reached successfully');
      assert.equal(testResponse.headers['ratelimit-remaining'], '4');
    });

    it('strips query parameters so they map to the same route counter', async () => {
      const app = express();
      app.get(
        '/api/products',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.0.0.4';

      // Req 1: /api/products?page=1
      const res1 = await request(app).get('/api/products?page=1').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);

      // Req 2: /api/products?page=2
      const res2 = await request(app).get('/api/products?page=2').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 200);

      // Req 3: /api/products?page=3 (Should be blocked, proving query params do not bypass limit)
      const res3 = await request(app).get('/api/products?page=3').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
    });
  });

  describe('Part 4: Window Expiration, Reset & Stale Entry Cleanup', () => {
    it('resets request counter to 1 when the window duration has elapsed', async () => {
      const app = express();
      // Short 100ms window for reliable testing
      app.get(
        '/test-expiry',
        rateLimiter({ limit: 1, windowMs: 100 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.0.0.5';

      // Request 1: Allowed
      const res1 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);

      // Request 2 (Immediate): Blocked
      const res2 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 429);

      // Wait 120ms for window to expire
      await new Promise((resolve) => setTimeout(resolve, 120));

      // Request 3 (After expiration): Allowed again!
      const res3 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 200);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });

    it('cleanupExpiredRecords removes stale records from in-memory Map', async () => {
      const app = express();
      app.get(
        '/test-cleanup',
        rateLimiter({ limit: 2, windowMs: 50 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.0.0.6';

      // Populate record in Map
      await request(app).get('/test-cleanup').set('X-Forwarded-For', testIp);

      // Wait 60ms for window to elapse
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Execute stale entry cleanup
      cleanupExpiredRecords();

      // Next request will find no record in Map and initialize fresh count = 1
      const freshRes = await request(app).get('/test-cleanup').set('X-Forwarded-For', testIp);
      assert.equal(freshRes.status, 200);
      assert.equal(freshRes.headers['ratelimit-remaining'], '1');
    });
  });
});
