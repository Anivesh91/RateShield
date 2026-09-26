import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { rateLimiter, StoreTimeoutError, withTimeout } from '../src/index.js';

describe('SmartRate v6 — Day 1: Store Timeout & Failure Policies', () => {

  describe('1. StoreTimeoutError Class', () => {
    it('instantiates with expected name, code, isTimeout, and timeoutMs properties', () => {
      const err = new StoreTimeoutError(250, 'Store timed out');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof StoreTimeoutError);
      assert.equal(err.name, 'StoreTimeoutError');
      assert.equal(err.code, 'ERR_STORE_TIMEOUT');
      assert.equal(err.isTimeout, true);
      assert.equal(err.timeoutMs, 250);
      assert.equal(err.message, 'Store timed out');
    });

    it('provides sensible defaults when arguments are omitted', () => {
      const err = new StoreTimeoutError();
      assert.equal(err.name, 'StoreTimeoutError');
      assert.equal(err.timeoutMs, 250);
      assert.equal(err.message, 'SmartRate: Rate limit store operation timed out after 250ms.');
    });
  });

  describe('2. withTimeout Utility', () => {
    it('resolves fast synchronous values immediately', async () => {
      const result = await withTimeout({ allowed: true, remaining: 5 }, 100);
      assert.deepEqual(result, { allowed: true, remaining: 5 });
    });

    it('resolves fast promises that complete before timeoutMs', async () => {
      const fastPromise = new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 10));
      const result = await withTimeout(fastPromise, 100);
      assert.deepEqual(result, { allowed: true });
    });

    it('rejects with StoreTimeoutError when promise exceeds timeoutMs', async () => {
      const slowPromise = new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 150));
      await assert.rejects(
        async () => withTimeout(slowPromise, 25),
        (err) => {
          assert.ok(err instanceof StoreTimeoutError);
          assert.equal(err.code, 'ERR_STORE_TIMEOUT');
          assert.equal(err.timeoutMs, 25);
          return true;
        }
      );
    });

    it('preserves underlying store rejection when it fails before timeout', async () => {
      const failingPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection dropped')), 10);
      });

      await assert.rejects(
        async () => withTimeout(failingPromise, 100),
        (err) => {
          assert.equal(err.message, 'Connection dropped');
          assert.equal(err.name, 'Error');
          return true;
        }
      );
    });

    it('throws RangeError if timeoutMs is <= 0 or not finite', async () => {
      const p = Promise.resolve('ok');
      await assert.rejects(async () => withTimeout(p, 0), { name: 'RangeError' });
      await assert.rejects(async () => withTimeout(p, -50), { name: 'RangeError' });
      await assert.rejects(async () => withTimeout(p, Infinity), { name: 'RangeError' });
      await assert.rejects(async () => withTimeout(p, '100'), { name: 'RangeError' });
    });
  });

  describe('3. Option Validation for Resilience Configuration', () => {
    it('throws RangeError when timeoutMs is 0, negative, or not a finite number', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, timeoutMs: 0 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, timeoutMs: -100 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, timeoutMs: '250' }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, timeoutMs: NaN }), { name: 'RangeError' });
    });

    it('throws TypeError when onStoreError is not a valid mode or function', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, onStoreError: 'invalid-mode' }), { name: 'TypeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, onStoreError: 123 }), { name: 'TypeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, onStoreError: true }), { name: 'TypeError' });
    });

    it('accepts valid timeoutMs and onStoreError configurations', () => {
      assert.doesNotThrow(() => rateLimiter({ limit: 5, windowMs: 60_000, timeoutMs: 500, onStoreError: 'fail-open' }));
      assert.doesNotThrow(() => rateLimiter({ limit: 5, windowMs: 60_000, timeoutMs: 250, onStoreError: 'fail-closed' }));
      assert.doesNotThrow(() => rateLimiter({ limit: 5, windowMs: 60_000, onStoreError: 'error' }));
      assert.doesNotThrow(() => rateLimiter({ limit: 5, windowMs: 60_000, onStoreError: (err, req, res, next) => next() }));
    });
  });

  describe('4. Fail-Open Strategy (Store Error & Timeout Bypass)', () => {
    it('waits for the store operation when timeoutMs is omitted', async () => {
      const slowStore = {
        async consume() {
          await new Promise((resolve) => setTimeout(resolve, 275));
          return { allowed: true, remaining: 4, reset: 60 };
        }
      };

      const app = express();
      app.get(
        '/no-store-timeout',
        rateLimiter({ limit: 5, windowMs: 60_000, store: slowStore }),
        (req, res) => res.status(200).json({ status: 'ok' })
      );

      const res = await request(app).get('/no-store-timeout');

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
    });

    it('allows request through with 200 OK and RateLimit-Degraded header on store rejection', async () => {
      const brokenStore = {
        async consume() {
          throw new Error('Redis connection refused: ECONNREFUSED');
        }
      };

      const app = express();
      let capturedRateLimitMeta = null;

      app.get(
        '/fail-open-error',
        rateLimiter({ limit: 5, windowMs: 60_000, store: brokenStore, onStoreError: 'fail-open' }),
        (req, res) => {
          capturedRateLimitMeta = req.rateLimit;
          res.status(200).json({ status: 'success', data: 'protected-resource' });
        }
      );

      const res = await request(app).get('/fail-open-error');
      assert.equal(res.status, 200);
      assert.equal(res.body.data, 'protected-resource');
      assert.equal(res.headers['ratelimit-degraded'], 'true');
      assert.ok(capturedRateLimitMeta);
      assert.equal(capturedRateLimitMeta.degraded, true);
      assert.equal(capturedRateLimitMeta.storeError.message, 'Redis connection refused: ECONNREFUSED');
    });

    it('allows request through with 200 OK and RateLimit-Degraded header on store timeout', async () => {
      const slowHangingStore = {
        async consume() {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { allowed: true, remaining: 4, reset: 60 };
        }
      };

      const app = express();
      app.get(
        '/fail-open-timeout',
        rateLimiter({ limit: 5, windowMs: 60_000, store: slowHangingStore, timeoutMs: 30, onStoreError: 'fail-open' }),
        (req, res) => res.status(200).json({ status: 'ok', msg: 'unblocked' })
      );

      const startTime = Date.now();
      const res = await request(app).get('/fail-open-timeout');
      const elapsed = Date.now() - startTime;

      assert.equal(res.status, 200);
      assert.equal(res.body.msg, 'unblocked');
      assert.equal(res.headers['ratelimit-degraded'], 'true');
      assert.ok(elapsed < 120, `Expected elapsed time < 120ms due to 30ms timeout, took ${elapsed}ms`);
    });
  });

  describe('5. Fail-Closed Strategy (Store Error & Timeout 503 Rejection)', () => {
    it('returns 503 Service Unavailable, RateLimit-Degraded, and Retry-After: 30 on store error', async () => {
      const downStore = {
        async consume() {
          throw new Error('Redis cluster failover in progress');
        }
      };

      const app = express();
      app.get(
        '/fail-closed-error',
        rateLimiter({ limit: 5, windowMs: 60_000, store: downStore, onStoreError: 'fail-closed' }),
        (req, res) => res.json({ shouldNotRun: true })
      );

      const res = await request(app).get('/fail-closed-error');
      assert.equal(res.status, 503);
      assert.equal(res.headers['ratelimit-degraded'], 'true');
      assert.equal(res.headers['retry-after'], '30');
      assert.equal(res.body.success, false);
      assert.equal(res.body.error, 'Service Unavailable');
      assert.equal(res.body.message, 'Rate limiting service temporarily unavailable');
    });

    it('returns 503 Service Unavailable with RateLimit-Degraded on store timeout', async () => {
      const slowStore = {
        async consume() {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { allowed: true, remaining: 1, reset: 60 };
        }
      };

      const app = express();
      app.get(
        '/fail-closed-timeout',
        rateLimiter({ limit: 5, windowMs: 60_000, store: slowStore, timeoutMs: 30, onStoreError: 'fail-closed' }),
        (req, res) => res.json({ shouldNotRun: true })
      );

      const res = await request(app).get('/fail-closed-timeout');
      assert.equal(res.status, 503);
      assert.equal(res.headers['ratelimit-degraded'], 'true');
      assert.equal(res.headers['retry-after'], '30');
      assert.equal(res.body.success, false);
    });
  });

  describe('6. Custom onStoreError Handler & Backward Compatibility', () => {
    it('delegates to custom function when provided', async () => {
      const brokenStore = {
        async consume() {
          throw new Error('DB connection pool exhausted');
        }
      };

      const app = express();
      app.get(
        '/custom-handler',
        rateLimiter({
          limit: 5,
          windowMs: 60_000,
          store: brokenStore,
          onStoreError: (err, req, res, next) => {
            res.status(502).json({
              customHandled: true,
              errorType: err.name,
              message: err.message
            });
          }
        }),
        (req, res) => res.json({ ok: true })
      );

      const res = await request(app).get('/custom-handler');
      assert.equal(res.status, 502);
      assert.equal(res.headers['ratelimit-degraded'], 'true');
      assert.equal(res.body.customHandled, true);
      assert.equal(res.body.message, 'DB connection pool exhausted');
    });

    it('preserves backwards compatibility by bubbling error to next(err) when onStoreError is omitted', async () => {
      const brokenStore = {
        async consume() {
          throw new Error('Uncaught Redis Store Outage');
        }
      };

      const app = express();
      app.get(
        '/default-error',
        rateLimiter({ limit: 5, windowMs: 60_000, store: brokenStore }),
        (req, res) => res.json({ ok: true })
      );

      // Standard Express 500 error handler
      app.use((err, req, res, next) => {
        res.status(500).json({ custom500: true, error: err.message });
      });

      const res = await request(app).get('/default-error');
      assert.equal(res.status, 500);
      assert.equal(res.headers['ratelimit-degraded'], 'true');
      assert.equal(res.body.custom500, true);
      assert.equal(res.body.error, 'Uncaught Redis Store Outage');
    });

    it('forwards rejected async custom handlers through next(err)', async () => {
      const brokenStore = { consume: async () => { throw new Error('store failed'); } };
      const app = express();

      app.get(
        '/async-custom-handler',
        rateLimiter({
          limit: 5,
          windowMs: 60_000,
          store: brokenStore,
          onStoreError: async () => { throw new Error('handler failed'); }
        }),
        (req, res) => res.json({ ok: true })
      );
      app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

      const res = await request(app).get('/async-custom-handler');

      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'handler failed');
    });
  });
});
