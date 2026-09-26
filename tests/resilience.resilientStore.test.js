import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import {
  rateLimiter,
  ResilientStore,
  MemoryStore,
  CircuitBreaker,
  CIRCUIT_STATE,
  CircuitBreakerOpenError,
  StoreTimeoutError
} from '../src/index.js';

describe('SmartRate v6 — Day 3: Dual-Store Fallback & ResilientStore Engine', () => {

  describe('1. ResilientStore Construction & Option Validation', () => {
    it('initializes successfully with valid primaryStore and defaults fallbackStore to MemoryStore', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      const resilient = new ResilientStore({ primaryStore: primaryMock });

      assert.equal(resilient.primaryStore, primaryMock);
      assert.ok(resilient.fallbackStore instanceof MemoryStore);
      assert.ok(resilient.circuitBreaker instanceof CircuitBreaker);
      assert.equal(resilient.timeoutMs, 250);
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.CLOSED);
    });

    it('accepts explicit custom fallbackStore, timeoutMs, and CircuitBreaker instance', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      const fallbackMock = { consume: async () => ({ allowed: true }) };
      const customBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        fallbackStore: fallbackMock,
        circuitBreaker: customBreaker,
        timeoutMs: 100
      });

      assert.equal(resilient.primaryStore, primaryMock);
      assert.equal(resilient.fallbackStore, fallbackMock);
      assert.equal(resilient.circuitBreaker, customBreaker);
      assert.equal(resilient.timeoutMs, 100);
      assert.equal(resilient.circuitBreaker.failureThreshold, 3);
    });

    it('accepts custom circuit breaker configuration options object', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 200 }
      });

      assert.equal(resilient.circuitBreaker.failureThreshold, 2);
      assert.equal(resilient.circuitBreaker.resetTimeoutMs, 200);
    });

    it('allows circuitBreaker: false to disable breaker protection', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        circuitBreaker: false
      });

      assert.equal(resilient.circuitBreaker, null);
    });

    it('throws fail-fast TypeError on missing or invalid primaryStore', () => {
      assert.throws(() => new ResilientStore(), { name: 'TypeError' });
      assert.throws(() => new ResilientStore({}), { name: 'TypeError' });
      assert.throws(() => new ResilientStore({ primaryStore: null }), { name: 'TypeError' });
      assert.throws(() => new ResilientStore({ primaryStore: { notConsume: () => {} } }), { name: 'TypeError' });
    });

    it('throws fail-fast TypeError on invalid fallbackStore', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      assert.throws(() => new ResilientStore({ primaryStore: primaryMock, fallbackStore: 'invalid' }), {
        name: 'TypeError'
      });
      assert.throws(() => new ResilientStore({ primaryStore: primaryMock, fallbackStore: {} }), {
        name: 'TypeError'
      });
    });

    it('throws fail-fast RangeError on invalid timeoutMs', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      assert.throws(() => new ResilientStore({ primaryStore: primaryMock, timeoutMs: 0 }), {
        name: 'RangeError'
      });
      assert.throws(() => new ResilientStore({ primaryStore: primaryMock, timeoutMs: -50 }), {
        name: 'RangeError'
      });
      assert.throws(() => new ResilientStore({ primaryStore: primaryMock, timeoutMs: NaN }), {
        name: 'RangeError'
      });
    });

    it('forwards circuit breaker events to ResilientStore listeners', async () => {
      const events = [];
      const primaryMock = {
        consume: async () => {
          throw new Error('primary down');
        }
      };
      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        failureThreshold: 2,
        resetTimeoutMs: 50,
        timeoutMs: 50
      });

      resilient.on('stateChange', (evt) => events.push(`state:${evt.to}`));
      resilient.on('circuitOpen', () => events.push('open'));

      const params = { key: 'test', limit: 5, windowMs: 1000 };
      await resilient.consume(params);
      await resilient.consume(params); // trips breaker

      assert.ok(events.includes('state:OPEN'));
      assert.ok(events.includes('open'));
    });
  });

  describe('2. Primary Store Happy Path Operation', () => {
    it('executes against primaryStore and returns non-degraded result without calling fallbackStore', async () => {
      let primaryCalled = 0;
      let fallbackCalled = 0;
      let primarySuccessEmitted = false;

      const primaryMock = {
        consume: async (params) => {
          primaryCalled++;
          return {
            allowed: true,
            limit: params.limit,
            remaining: 4,
            reset: 60,
            retryAfter: 0
          };
        }
      };

      const fallbackMock = {
        consume: async () => {
          fallbackCalled++;
          return { allowed: true, limit: 5, remaining: 5, reset: 60, retryAfter: 0 };
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        fallbackStore: fallbackMock,
        timeoutMs: 100
      });

      resilient.on('primarySuccess', () => {
        primarySuccessEmitted = true;
      });

      const result = await resilient.consume({ key: 'client-1', limit: 5, windowMs: 60000 });

      assert.equal(primaryCalled, 1);
      assert.equal(fallbackCalled, 0);
      assert.equal(primarySuccessEmitted, true);
      assert.equal(result.allowed, true);
      assert.equal(result.remaining, 4);
      assert.equal(result.degraded, false);
      assert.equal(result.fallbackUsed, false);
      assert.equal(result.store, 'primary');
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.CLOSED);
    });
  });

  describe('3. Transparent Failover on Primary Error & Timeout', () => {
    it('fails over cleanly to fallbackStore when primaryStore throws an infrastructure error', async () => {
      let fallbackEventReceived = null;
      const primaryMock = {
        consume: async () => {
          throw new Error('Redis connection ECONNREFUSED');
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        timeoutMs: 100
      });

      resilient.on('fallback', (evt) => {
        fallbackEventReceived = evt;
      });

      const result = await resilient.consume({ key: 'user-42', limit: 10, windowMs: 60000 });

      assert.equal(result.allowed, true);
      assert.equal(result.degraded, true);
      assert.equal(result.fallbackUsed, true);
      assert.equal(result.store, 'fallback');
      assert.equal(result.remaining, 9);
      assert.ok(result.primaryError instanceof Error);
      assert.equal(result.primaryError.message, 'Redis connection ECONNREFUSED');

      assert.ok(fallbackEventReceived);
      assert.equal(fallbackEventReceived.key, 'user-42');
      assert.equal(fallbackEventReceived.circuitState, CIRCUIT_STATE.CLOSED);
      assert.equal(resilient.circuitBreaker.getStats().consecutiveFailures, 1);
    });

    it('fails over cleanly to fallbackStore when primaryStore times out', async () => {
      const primaryMock = {
        consume: async () => new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 150))
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        timeoutMs: 25 // Short timeout triggers timeout guard
      });

      const startTime = Date.now();
      const result = await resilient.consume({ key: 'user-timeout', limit: 5, windowMs: 60000 });
      const elapsed = Date.now() - startTime;

      assert.ok(elapsed < 120, `Execution should complete promptly on timeout failover (took ${elapsed}ms)`);
      assert.equal(result.allowed, true);
      assert.equal(result.degraded, true);
      assert.equal(result.fallbackUsed, true);
      assert.equal(result.store, 'fallback');
      assert.ok(result.primaryError instanceof StoreTimeoutError);
      assert.equal(resilient.circuitBreaker.getStats().consecutiveFailures, 1);
    });
  });

  describe('4. Circuit Breaker Tripping & Zero Primary Hammering', () => {
    it('trips circuit to OPEN after failureThreshold and completely bypasses primaryStore', async () => {
      let primaryAttempts = 0;
      const primaryMock = {
        consume: async () => {
          primaryAttempts++;
          throw new Error('Redis cluster unreachable');
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        failureThreshold: 3,
        resetTimeoutMs: 500,
        timeoutMs: 50
      });

      const params = { key: 'client-trip', limit: 10, windowMs: 60000 };

      // 1st, 2nd, 3rd failures trip breaker
      await resilient.consume(params);
      await resilient.consume(params);
      await resilient.consume(params);

      assert.equal(primaryAttempts, 3);
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.OPEN);

      // Subsequent 5 requests while OPEN must NEVER call primaryStore
      for (let i = 0; i < 5; i++) {
        const res = await resilient.consume(params);
        assert.equal(res.degraded, true);
        assert.equal(res.fallbackUsed, true);
        assert.equal(res.store, 'fallback');
        assert.ok(res.primaryError instanceof CircuitBreakerOpenError);
      }

      // Assert zero additional primary calls (zero hammering)
      assert.equal(primaryAttempts, 3, 'Primary store was called while circuit was OPEN!');
    });
  });

  describe('5. Local In-Memory Safe Quota Degradation', () => {
    it('strictly enforces rate limits in fallback MemoryStore during primary outage', async () => {
      const primaryMock = {
        consume: async () => {
          throw new Error('Redis unavailable');
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        failureThreshold: 2,
        resetTimeoutMs: 1000
      });

      const limit = 3;
      const params = { key: 'abuse-client', limit, windowMs: 60000 };

      // Request 1: allowed, remaining = 2
      const r1 = await resilient.consume(params);
      assert.equal(r1.allowed, true);
      assert.equal(r1.remaining, 2);
      assert.equal(r1.degraded, true);

      // Request 2: allowed, remaining = 1
      const r2 = await resilient.consume(params);
      assert.equal(r2.allowed, true);
      assert.equal(r2.remaining, 1);
      assert.equal(r2.degraded, true);

      // Request 3: allowed, remaining = 0
      const r3 = await resilient.consume(params);
      assert.equal(r3.allowed, true);
      assert.equal(r3.remaining, 0);
      assert.equal(r3.degraded, true);

      // Request 4: BLOCKED locally by MemoryStore with 429 semantics
      const r4 = await resilient.consume(params);
      assert.equal(r4.allowed, false, 'Fallback store must enforce quota and block excess traffic');
      assert.equal(r4.remaining, 0);
      assert.ok(r4.retryAfter > 0);
      assert.equal(r4.degraded, true);
      assert.equal(r4.fallbackUsed, true);
    });

    it('works across different rate limit keys independently during degradation', async () => {
      const primaryMock = {
        consume: async () => {
          throw new Error('Redis timeout');
        }
      };

      const resilient = new ResilientStore({ primaryStore: primaryMock });

      const rUserA = await resilient.consume({ key: 'user-A', limit: 2, windowMs: 60000 });
      const rUserB = await resilient.consume({ key: 'user-B', limit: 2, windowMs: 60000 });

      assert.equal(rUserA.allowed, true);
      assert.equal(rUserA.remaining, 1);
      assert.equal(rUserB.allowed, true);
      assert.equal(rUserB.remaining, 1);
    });
  });

  describe('6. Seamless Canary Recovery (HALF_OPEN -> CLOSED)', () => {
    it('transfers traffic back to primaryStore once canary probe succeeds', async () => {
      let isRedisAlive = false;
      let primaryCalls = 0;

      const primaryMock = {
        consume: async () => {
          primaryCalls++;
          if (!isRedisAlive) {
            throw new Error('Redis still unreachable');
          }
          return { allowed: true, limit: 10, remaining: 9, reset: 60, retryAfter: 0 };
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        failureThreshold: 2,
        resetTimeoutMs: 60 // 60ms cooldown
      });

      const params = { key: 'canary-client', limit: 10, windowMs: 60000 };

      // 1. Fail twice to trip circuit to OPEN
      await resilient.consume(params);
      await resilient.consume(params);
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.OPEN);
      assert.equal(primaryCalls, 2);

      // 2. Request before cooldown stays on fallback without calling primary
      const preCooldown = await resilient.consume(params);
      assert.equal(preCooldown.degraded, true);
      assert.equal(primaryCalls, 2);

      // 3. Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 4. Redis is now healed!
      isRedisAlive = true;

      // 5. Next request acts as lazy trigger: breaker enters HALF_OPEN, sends canary probe
      let probeEventFired = false;
      let circuitCloseEventFired = false;
      resilient.on('probe', () => {
        probeEventFired = true;
      });
      resilient.on('circuitClose', () => {
        circuitCloseEventFired = true;
      });

      const canaryResult = await resilient.consume(params);

      assert.equal(primaryCalls, 3);
      assert.equal(probeEventFired, true);
      assert.equal(circuitCloseEventFired, true);
      assert.equal(canaryResult.degraded, false);
      assert.equal(canaryResult.fallbackUsed, false);
      assert.equal(canaryResult.store, 'primary');
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.CLOSED);

      // 6. Subsequent requests execute normally on primaryStore
      const postRecoveryResult = await resilient.consume(params);
      assert.equal(primaryCalls, 4);
      assert.equal(postRecoveryResult.degraded, false);
      assert.equal(postRecoveryResult.store, 'primary');
    });

    it('routes concurrent requests to fallbackStore while canary probe is in-flight', async () => {
      let isRedisAlive = false;
      let primaryCalls = 0;
      let resolveCanary;

      const primaryMock = {
        consume: async () => {
          primaryCalls++;
          if (!isRedisAlive) {
            throw new Error('Redis down');
          }
          // Hold the canary probe pending
          return new Promise((resolve) => {
            resolveCanary = () => resolve({ allowed: true, limit: 10, remaining: 8, reset: 60, retryAfter: 0 });
          });
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        failureThreshold: 2,
        resetTimeoutMs: 50
      });

      const params = { key: 'concurrent-canary', limit: 10, windowMs: 60000 };

      // Trip to OPEN
      await resilient.consume(params);
      await resilient.consume(params);
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.OPEN);

      await new Promise((resolve) => setTimeout(resolve, 60));
      isRedisAlive = true;

      // Launch canary probe (remains pending until resolveCanary is called)
      const canaryPromise = resilient.consume(params);

      // Immediately launch 2 concurrent requests while canary is in-flight
      const concurrentPromise1 = resilient.consume(params);
      const concurrentPromise2 = resilient.consume(params);

      // Concurrent requests should not stampede Redis, but immediately consume from fallbackStore
      const [conc1, conc2] = await Promise.all([concurrentPromise1, concurrentPromise2]);
      assert.equal(conc1.degraded, true);
      assert.equal(conc1.fallbackUsed, true);
      assert.equal(conc2.degraded, true);
      assert.equal(conc2.fallbackUsed, true);
      assert.equal(primaryCalls, 3); // Exactly 1 canary probe dispatched to primary

      // Now resolve the canary probe
      resolveCanary();
      const canaryRes = await canaryPromise;

      assert.equal(canaryRes.degraded, false);
      assert.equal(canaryRes.store, 'primary');
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.CLOSED);
    });

    it('returns to OPEN if canary probe fails', async () => {
      const primaryMock = {
        consume: async () => {
          throw new Error('Redis still down');
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        failureThreshold: 2,
        resetTimeoutMs: 50
      });

      const params = { key: 'probe-fail', limit: 10, windowMs: 60000 };

      // Trip to OPEN
      await resilient.consume(params);
      await resilient.consume(params);
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.OPEN);

      await new Promise((resolve) => setTimeout(resolve, 60));

      // Canary runs and fails
      const res = await resilient.consume(params);
      assert.equal(res.degraded, true);
      assert.equal(resilient.circuitBreaker.getState(), CIRCUIT_STATE.OPEN);
    });
  });

  describe('7. Double-Fault & Error Propagation', () => {
    it('bubbles error up when both primaryStore and fallbackStore fail', async () => {
      const primaryMock = {
        consume: async () => {
          throw new Error('Primary database down');
        }
      };
      const fallbackMock = {
        consume: async () => {
          throw new Error('Memory store corrupted');
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        fallbackStore: fallbackMock
      });

      await assert.rejects(
        async () => resilient.consume({ key: 'double-fault', limit: 5, windowMs: 60000 }),
        /Memory store corrupted/
      );
    });
  });

  describe('8. Express Integration & Header Tagging', () => {
    it('preserves circuitBreaker: false when constructing fallbackStore resilience', () => {
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        store: { consume: async () => ({ allowed: true }) },
        fallbackStore: true,
        circuitBreaker: false
      });

      assert.equal(limiter.circuitBreaker, null);
    });

    it('uses the ResilientStore breaker and rejects conflicting middleware breaker options', () => {
      const resilientStore = new ResilientStore({ primaryStore: { consume: async () => ({ allowed: true }) } });
      const limiter = rateLimiter({ store: resilientStore, limit: 5, windowMs: 60000 });

      assert.equal(limiter.circuitBreaker, resilientStore.circuitBreaker);
      assert.throws(
        () => rateLimiter({ store: resilientStore, limit: 5, windowMs: 60000, circuitBreaker: true }),
        { name: 'TypeError' }
      );
      assert.doesNotThrow(() => rateLimiter({
        store: resilientStore,
        limit: 5,
        windowMs: 60000,
        circuitBreaker: resilientStore.circuitBreaker
      }));
      assert.throws(
        () => rateLimiter({ store: resilientStore, limit: 5, windowMs: 60000, failureThreshold: 2 }),
        { name: 'TypeError' }
      );
    });

    it('sets RateLimit-Degraded: true and attaches req.rateLimit metadata during outage', async () => {
      let redisHealthy = true;

      const mockRedisStore = {
        consume: async (params) => {
          if (!redisHealthy) {
            throw new Error('Redis connection dropped');
          }
          return { allowed: true, limit: params.limit, remaining: 4, reset: 60, retryAfter: 0 };
        }
      };

      const resilientStore = new ResilientStore({
        primaryStore: mockRedisStore,
        failureThreshold: 2,
        resetTimeoutMs: 100,
        timeoutMs: 50
      });

      let capturedRateLimitMeta = null;

      const app = express();
      app.use(
        rateLimiter({
          store: resilientStore,
          limit: 5,
          windowMs: 60000
        })
      );
      app.get('/api/test', (req, res) => {
        capturedRateLimitMeta = req.rateLimit;
        res.json({ success: true });
      });

      // 1. Healthy request
      const resHealthy = await request(app).get('/api/test');
      assert.equal(resHealthy.status, 200);
      assert.equal(resHealthy.headers['ratelimit-degraded'], undefined);
      assert.equal(resHealthy.headers['ratelimit-limit'], '5');
      assert.equal(resHealthy.headers['ratelimit-remaining'], '4');

      // 2. Outage begins
      redisHealthy = false;

      const resOutage = await request(app).get('/api/test');
      assert.equal(resOutage.status, 200);
      assert.equal(resOutage.headers['ratelimit-degraded'], 'true');
      assert.ok(capturedRateLimitMeta);
      assert.equal(capturedRateLimitMeta.degraded, true);
      assert.equal(capturedRateLimitMeta.fallbackUsed, true);
      assert.equal(capturedRateLimitMeta.store, 'fallback');
      assert.equal(capturedRateLimitMeta.primaryError, 'Error');

      // 3. Fallback quota enforcement in Express (limit: 5)
      // Consume the remaining 4 tokens on fallback MemoryStore
      await request(app).get('/api/test');
      await request(app).get('/api/test');
      await request(app).get('/api/test');
      await request(app).get('/api/test');

      // 6th request: Exceeds fallback local limit -> 429 Too Many Requests
      const resBlocked = await request(app).get('/api/test');
      assert.equal(resBlocked.status, 429);
      assert.equal(resBlocked.headers['ratelimit-degraded'], 'true');
      assert.equal(resBlocked.body.message, 'Too many requests');
    });

    it('supports rateLimiter shorthand fallbackStore: true option', async () => {
      let redisHealthy = true;

      const mockRedisStore = {
        consume: async (params) => {
          if (!redisHealthy) {
            throw new Error('Redis node failure');
          }
          return { allowed: true, limit: params.limit, remaining: 9, reset: 60, retryAfter: 0 };
        }
      };

      const app = express();
      app.use(
        rateLimiter({
          store: mockRedisStore,
          fallbackStore: true,
          limit: 10,
          windowMs: 60000,
          timeoutMs: 50,
          failureThreshold: 2,
          resetTimeoutMs: 80
        })
      );
      app.get('/api/shorthand', (req, res) => res.json({ ok: true, degraded: req.rateLimit?.degraded }));

      // 1. Initial healthy request
      const r1 = await request(app).get('/api/shorthand');
      assert.equal(r1.status, 200);
      assert.equal(r1.headers['ratelimit-degraded'], undefined);

      // 2. Redis fails
      redisHealthy = false;
      const r2 = await request(app).get('/api/shorthand');
      assert.equal(r2.status, 200);
      assert.equal(r2.headers['ratelimit-degraded'], 'true');
      assert.equal(r2.body.degraded, true);

      // 3. Redis recovers after cooldown
      await new Promise((resolve) => setTimeout(resolve, 100));
      redisHealthy = true;

      const r3 = await request(app).get('/api/shorthand');
      assert.equal(r3.status, 200);
      assert.equal(r3.headers['ratelimit-degraded'], undefined);
    });

    it('works seamlessly with Token Bucket algorithm under degraded fallback', async () => {
      const mockRedis = {
        consume: async () => {
          throw new Error('Redis timeout');
        }
      };

      const resilientStore = new ResilientStore({ primaryStore: mockRedis });

      const app = express();
      app.use(
        rateLimiter({
          store: resilientStore,
          algorithm: 'token-bucket',
          capacity: 3,
          refillRate: 1,
          refillIntervalMs: 60000
        })
      );
      app.get('/api/tokens', (req, res) => res.json({ ok: true }));

      // 3 requests consume capacity
      const r1 = await request(app).get('/api/tokens');
      const r2 = await request(app).get('/api/tokens');
      const r3 = await request(app).get('/api/tokens');

      assert.equal(r1.status, 200);
      assert.equal(r1.headers['ratelimit-degraded'], 'true');
      assert.equal(r2.status, 200);
      assert.equal(r3.status, 200);

      // 4th request blocked by Token Bucket in fallback MemoryStore
      const r4 = await request(app).get('/api/tokens');
      assert.equal(r4.status, 429);
      assert.equal(r4.headers['ratelimit-degraded'], 'true');
      assert.ok(Number(r4.headers['retry-after']) >= 1);
    });
  });

  describe('9. Cleanup & Snapshot Statistics', () => {
    it('invokes cleanupExpiredRecords on both primary and fallback stores', () => {
      let primaryCleaned = false;
      let fallbackCleaned = false;

      const primaryMock = {
        consume: async () => ({ allowed: true }),
        cleanupExpiredRecords: () => {
          primaryCleaned = true;
          return 5;
        }
      };

      const fallbackMock = {
        consume: async () => ({ allowed: true }),
        cleanupExpiredRecords: () => {
          fallbackCleaned = true;
          return 2;
        }
      };

      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        fallbackStore: fallbackMock
      });

      const totalEvicted = resilient.cleanupExpiredRecords(Date.now());
      assert.equal(primaryCleaned, true);
      assert.equal(fallbackCleaned, true);
      assert.equal(totalEvicted, 7);
    });

    it('returns accurate getStats snapshot', () => {
      const primaryMock = { consume: async () => ({ allowed: true }) };
      const resilient = new ResilientStore({
        primaryStore: primaryMock,
        timeoutMs: 150,
        failureThreshold: 4,
        resetTimeoutMs: 8000
      });

      const stats = resilient.getStats();
      assert.equal(stats.timeoutMs, 150);
      assert.equal(stats.hasFallbackStore, true);
      assert.ok(stats.circuitBreaker);
      assert.equal(stats.circuitBreaker.state, CIRCUIT_STATE.CLOSED);
      assert.equal(stats.circuitBreaker.failureThreshold, 4);
      assert.equal(stats.circuitBreaker.resetTimeoutMs, 8000);
    });
  });
});
