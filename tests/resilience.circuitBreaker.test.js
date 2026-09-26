import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import {
  rateLimiter,
  CircuitBreaker,
  CIRCUIT_STATE,
  CircuitBreakerOpenError
} from '../src/index.js';

describe('SmartRate v6 — Day 2: Store Circuit Breaker Engine', () => {

  describe('1. CircuitBreaker Class Construction & Validation', () => {
    it('initializes in CLOSED state with configured default options', () => {
      const cb = new CircuitBreaker();
      assert.equal(cb.getState(), CIRCUIT_STATE.CLOSED);
      assert.equal(cb.isClosed(), true);
      assert.equal(cb.isOpen(), false);
      assert.equal(cb.isHalfOpen(), false);
      assert.equal(cb.failureThreshold, 5);
      assert.equal(cb.resetTimeoutMs, 10000);
      assert.equal(cb.successThreshold, 1);
    });

    it('accepts custom valid configuration options', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500, successThreshold: 2 });
      assert.equal(cb.failureThreshold, 3);
      assert.equal(cb.resetTimeoutMs, 500);
      assert.equal(cb.successThreshold, 2);
    });

    it('throws RangeError fail-fast on invalid parameters', () => {
      assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ failureThreshold: -1 }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ failureThreshold: 2.5 }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ resetTimeoutMs: 0 }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ resetTimeoutMs: -100 }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ resetTimeoutMs: Infinity }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ successThreshold: 0 }), { name: 'RangeError' });
      assert.throws(() => new CircuitBreaker({ successThreshold: -2 }), { name: 'RangeError' });
    });

    it('throws TypeError when execute is called with a non-function', async () => {
      const cb = new CircuitBreaker();
      await assert.rejects(async () => cb.execute(null), { name: 'TypeError' });
      await assert.rejects(async () => cb.execute('not-a-fn'), { name: 'TypeError' });
    });
  });

  describe('2. State Transitions & Single-Flight Canary Probe', () => {
    it('executes normally in CLOSED state and resets consecutive failure count on success', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });

      // 1 failure
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Flake 1'))));
      assert.equal(cb.getStats().consecutiveFailures, 1);

      // Successful call resets failures
      const res = await cb.execute(() => Promise.resolve('recovered'));
      assert.equal(res, 'recovered');
      assert.equal(cb.getStats().consecutiveFailures, 0);
      assert.equal(cb.getState(), CIRCUIT_STATE.CLOSED);
    });

    it('trips from CLOSED to OPEN when consecutive failures reach failureThreshold', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
      let tripEmitted = false;
      let stateChangeEmitted = false;

      cb.on('trip', (evt) => {
        tripEmitted = true;
        assert.equal(evt.consecutiveFailures, 2);
      });
      cb.on('stateChange', (evt) => {
        if (evt.to === CIRCUIT_STATE.OPEN) {
          stateChangeEmitted = true;
          assert.equal(evt.from, CIRCUIT_STATE.CLOSED);
        }
      });

      // Failure 1
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Error 1'))));
      assert.equal(cb.getState(), CIRCUIT_STATE.CLOSED);

      // Failure 2 -> TRIPS
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Error 2'))));
      assert.equal(cb.getState(), CIRCUIT_STATE.OPEN);
      assert.equal(cb.isOpen(), true);
      assert.equal(tripEmitted, true);
      assert.equal(stateChangeEmitted, true);
    });

    it('fast-fails immediately with CircuitBreakerOpenError when OPEN without invoking target function', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      let calls = 0;
      const fn = () => { calls++; return Promise.resolve('ok'); };

      // Trip the breaker
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Outage'))));
      assert.equal(cb.isOpen(), true);

      // Subsequent call while OPEN
      await assert.rejects(
        async () => cb.execute(fn),
        (err) => {
          assert.ok(err instanceof CircuitBreakerOpenError);
          assert.equal(err.code, 'ERR_CIRCUIT_OPEN');
          assert.equal(err.isCircuitOpen, true);
          return true;
        }
      );

      // The target function must NOT have been called
      assert.equal(calls, 0);
    });

    it('transitions to HALF_OPEN after resetTimeoutMs and closes on successful canary probe', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30, successThreshold: 1 });
      let probeEmitted = false;
      let closeEmitted = false;

      cb.on('probe', () => { probeEmitted = true; });
      cb.on('close', () => { closeEmitted = true; });

      // Trip
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Fail'))));
      assert.equal(cb.isOpen(), true);

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(cb.isHalfOpen(), true);

      // Canary probe succeeds
      const result = await cb.execute(() => Promise.resolve('probe-ok'));
      assert.equal(result, 'probe-ok');
      assert.equal(cb.isClosed(), true);
      assert.equal(probeEmitted, true);
      assert.equal(closeEmitted, true);
      assert.equal(cb.getStats().consecutiveFailures, 0);
    });

    it('trips back to OPEN if canary probe fails in HALF_OPEN state', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30 });

      // Trip
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Fail 1'))));
      assert.equal(cb.isOpen(), true);

      // Wait for HALF_OPEN
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(cb.isHalfOpen(), true);

      // Canary probe fails
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Probe failed'))));

      // Should be OPEN again
      assert.equal(cb.isOpen(), true);
    });

    it('blocks concurrent executions during in-flight canary probe in HALF_OPEN', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30 });

      // Trip
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('Fail 1'))));

      // Wait for HALF_OPEN
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(cb.isHalfOpen(), true);

      // Launch slow probe
      const slowProbe = cb.execute(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'probe-success';
      });

      // Immediate concurrent call while probe is in-flight must be rejected with CircuitBreakerOpenError
      await assert.rejects(
        async () => cb.execute(() => Promise.resolve('should-not-run')),
        (err) => {
          assert.ok(err instanceof CircuitBreakerOpenError);
          assert.match(err.message, /canary probe is already in-flight/);
          return true;
        }
      );

      const probeResult = await slowProbe;
      assert.equal(probeResult, 'probe-success');
      assert.equal(cb.isClosed(), true);
    });

    it('does not let a pre-probe call record a HALF_OPEN outcome or release the probe slot', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30 });
      let resolveEarlierCall;
      let resolveProbe;

      const earlierCall = cb.execute(() => new Promise((resolve) => {
        resolveEarlierCall = resolve;
      }));
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('trip'))));
      await new Promise((resolve) => setTimeout(resolve, 40));

      const probe = cb.execute(() => new Promise((resolve) => {
        resolveProbe = resolve;
      }));
      resolveEarlierCall('earlier-success');
      assert.equal(await earlierCall, 'earlier-success');
      assert.equal(cb.isHalfOpen(), true);
      assert.equal(cb.getStats().probeInFlight, true);

      await assert.rejects(
        async () => cb.execute(() => Promise.resolve('unexpected')),
        { name: 'CircuitBreakerOpenError' }
      );

      resolveProbe('probe-success');
      assert.equal(await probe, 'probe-success');
      assert.equal(cb.isClosed(), true);
    });

    it('ignores stale probe outcomes after manual reset or trip', async () => {
      const createHalfOpenBreaker = async () => {
        const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30 });
        await assert.rejects(async () => breaker.execute(() => Promise.reject(new Error('trip'))));
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(breaker.isHalfOpen(), true);
        return breaker;
      };

      const resetBreaker = await createHalfOpenBreaker();
      let rejectStaleProbe;
      const staleFailure = resetBreaker.execute(() => new Promise((resolve, reject) => {
        rejectStaleProbe = reject;
      }));
      resetBreaker.reset();
      rejectStaleProbe(new Error('stale probe failure'));
      await assert.rejects(staleFailure, /stale probe failure/);
      assert.equal(resetBreaker.isClosed(), true);
      assert.equal(resetBreaker.getStats().consecutiveFailures, 0);
      assert.equal(resetBreaker.getStats().probeInFlight, false);

      const trippedBreaker = await createHalfOpenBreaker();
      let resolveStaleProbe;
      const staleSuccess = trippedBreaker.execute(() => new Promise((resolve) => {
        resolveStaleProbe = resolve;
      }));
      trippedBreaker.trip();
      resolveStaleProbe('stale probe success');
      assert.equal(await staleSuccess, 'stale probe success');
      assert.equal(trippedBreaker.isOpen(), true);
      assert.equal(trippedBreaker.getStats().probeInFlight, false);
    });

    it('supports manual trip() and reset() overrides', () => {
      const cb = new CircuitBreaker();
      assert.equal(cb.isClosed(), true);

      cb.trip();
      assert.equal(cb.isOpen(), true);

      cb.reset();
      assert.equal(cb.isClosed(), true);
      assert.equal(cb.getStats().consecutiveFailures, 0);
    });
  });

  describe('3. rateLimiter Integration Option Validation', () => {
    it('throws TypeError when circuitBreaker option is neither boolean, object, nor CircuitBreaker instance', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, circuitBreaker: 123 }), { name: 'TypeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, circuitBreaker: 'yes' }), { name: 'TypeError' });
    });

    it('throws RangeError when nested circuitBreaker options are invalid', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, circuitBreaker: { failureThreshold: 0 } }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, circuitBreaker: { resetTimeoutMs: -50 } }), { name: 'RangeError' });
    });

    it('throws RangeError when top-level failureThreshold or resetTimeoutMs are invalid', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, failureThreshold: -2 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60_000, resetTimeoutMs: 0 }), { name: 'RangeError' });
    });

    it('attaches circuitBreaker instance to returned middleware function', () => {
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 500 }
      });
      assert.ok(limiter.circuitBreaker instanceof CircuitBreaker);
      assert.equal(limiter.circuitBreaker.failureThreshold, 3);
    });
  });

  describe('4. Express Integration: Unhealthy Store Shielding & Fail-Open / Fail-Closed', () => {
    it('shields failing store once circuit trips, stopping calls to store.consume completely', async () => {
      let storeConsumeCalls = 0;
      const dyingStore = {
        async consume() {
          storeConsumeCalls++;
          throw new Error('Redis connection timed out');
        }
      };

      const app = express();
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        store: dyingStore,
        circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
        onStoreError: 'fail-open'
      });

      app.get('/shielded-resource', limiter, (req, res) => {
        res.json({ ok: true, isDegraded: req.rateLimit?.degraded });
      });

      // First 3 requests hit the store and fail open (trips circuit on 3rd failure)
      const res1 = await request(app).get('/shielded-resource');
      const res2 = await request(app).get('/shielded-resource');
      const res3 = await request(app).get('/shielded-resource');

      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(res3.status, 200);
      assert.equal(storeConsumeCalls, 3);
      assert.equal(limiter.circuitBreaker.isOpen(), true);

      // Requests 4, 5, 6 arrive while circuit is OPEN
      const res4 = await request(app).get('/shielded-resource');
      const res5 = await request(app).get('/shielded-resource');
      const res6 = await request(app).get('/shielded-resource');

      assert.equal(res4.status, 200);
      assert.equal(res5.status, 200);
      assert.equal(res6.status, 200);

      // Crucial: store.consume MUST NOT have been called for requests 4, 5, 6!
      assert.equal(storeConsumeCalls, 3);
      assert.equal(res4.headers['ratelimit-degraded'], 'true');
    });

    it('fast-fails with 503 Service Unavailable when circuit is OPEN under fail-closed policy', async () => {
      let storeConsumeCalls = 0;
      const failingStore = {
        async consume() {
          storeConsumeCalls++;
          throw new Error('Redis cluster unreachable');
        }
      };

      const app = express();
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        store: failingStore,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000 },
        onStoreError: 'fail-closed'
      });

      app.get('/fail-closed-circuit', limiter, (req, res) => res.json({ success: true }));

      // 1st request fails
      const r1 = await request(app).get('/fail-closed-circuit');
      assert.equal(r1.status, 503);
      assert.equal(storeConsumeCalls, 1);

      // 2nd request fails -> TRIPS to OPEN
      const r2 = await request(app).get('/fail-closed-circuit');
      assert.equal(r2.status, 503);
      assert.equal(storeConsumeCalls, 2);
      assert.equal(limiter.circuitBreaker.isOpen(), true);

      // 3rd request arrives with OPEN circuit: fast-fails with 503 without touching store
      const r3 = await request(app).get('/fail-closed-circuit');
      assert.equal(r3.status, 503);
      assert.equal(r3.headers['ratelimit-degraded'], 'true');
      assert.equal(r3.headers['retry-after'], '5');
      assert.equal(storeConsumeCalls, 2); // Still 2! Not touched
    });

    it('probes store recovery after resetTimeoutMs and resumes normal limiting on success', async () => {
      let isHealthy = false;
      let consumeCalls = 0;
      const intermittentStore = {
        async consume({ limit }) {
          consumeCalls++;
          if (!isHealthy) {
            throw new Error('Redis temporary fault');
          }
          return { allowed: true, remaining: limit - 1, reset: 60 };
        }
      };

      const app = express();
      const limiter = rateLimiter({
        limit: 10,
        windowMs: 60_000,
        store: intermittentStore,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 50 },
        onStoreError: 'fail-open'
      });

      app.get('/recovery-route', limiter, (req, res) => res.json({ ok: true }));

      // Trip circuit
      await request(app).get('/recovery-route');
      await request(app).get('/recovery-route');
      assert.equal(limiter.circuitBreaker.isOpen(), true);
      assert.equal(consumeCalls, 2);

      // Store recovers
      isHealthy = true;

      // Wait for resetTimeoutMs
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(limiter.circuitBreaker.isHalfOpen(), true);

      // Canary probe request
      const probeRes = await request(app).get('/recovery-route');
      assert.equal(probeRes.status, 200);
      assert.equal(consumeCalls, 3);
      assert.equal(limiter.circuitBreaker.isClosed(), true);
      // Degraded header should NO LONGER be set on healthy recovery!
      assert.equal(probeRes.headers['ratelimit-degraded'], undefined);
      assert.equal(probeRes.headers['ratelimit-limit'], '10');
      assert.equal(probeRes.headers['ratelimit-remaining'], '9');
    });

    it('allows sharing a single CircuitBreaker instance across multiple Express routes', async () => {
      const sharedBreaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5000 });
      let brokenConsumeCount = 0;

      const brokenStore = {
        async consume() {
          brokenConsumeCount++;
          throw new Error('Shared store offline');
        }
      };

      const app = express();
      const routeALimiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        store: brokenStore,
        circuitBreaker: sharedBreaker,
        onStoreError: 'fail-open'
      });
      const routeBLimiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        store: brokenStore,
        circuitBreaker: sharedBreaker,
        onStoreError: 'fail-open'
      });

      app.get('/route-a', routeALimiter, (req, res) => res.json({ route: 'A' }));
      app.get('/route-b', routeBLimiter, (req, res) => res.json({ route: 'B' }));

      // 2 failures on route A trips the shared breaker
      await request(app).get('/route-a');
      await request(app).get('/route-a');
      assert.equal(sharedBreaker.isOpen(), true);
      assert.equal(brokenConsumeCount, 2);

      // Route B immediately benefits from the shared tripped breaker and does NOT hit brokenStore
      const resB = await request(app).get('/route-b');
      assert.equal(resB.status, 200);
      assert.equal(resB.headers['ratelimit-degraded'], 'true');
      assert.equal(brokenConsumeCount, 2); // Unchanged!
    });
  });

  describe('5. Precise Failure Classification & Dependency Isolation', () => {
    it('does NOT count rate-limit 429 quota exhaustion as a breaker failure', async () => {
      const app = express();
      const limiter = rateLimiter({
        limit: 2,
        windowMs: 60_000,
        circuitBreaker: { failureThreshold: 2 }
      });

      app.get('/quota-test', limiter, (req, res) => res.json({ allowed: true }));

      // Request 1: 200
      const r1 = await request(app).get('/quota-test');
      assert.equal(r1.status, 200);
      assert.equal(limiter.circuitBreaker.getStats().consecutiveFailures, 0);

      // Request 2: 200
      const r2 = await request(app).get('/quota-test');
      assert.equal(r2.status, 200);
      assert.equal(limiter.circuitBreaker.getStats().consecutiveFailures, 0);

      // Request 3: 429 Too Many Requests
      const r3 = await request(app).get('/quota-test');
      assert.equal(r3.status, 429);
      // Quota exhaustion is expected rate-limiting behavior, NOT a store/infra failure!
      assert.equal(limiter.circuitBreaker.getStats().consecutiveFailures, 0);
      assert.equal(limiter.circuitBreaker.isClosed(), true);

      // Request 4: 429 Too Many Requests
      const r4 = await request(app).get('/quota-test');
      assert.equal(r4.status, 429);
      assert.equal(limiter.circuitBreaker.getStats().consecutiveFailures, 0);
      assert.equal(limiter.circuitBreaker.isClosed(), true);
    });

    it('does NOT count keyGenerator errors as breaker failures', async () => {
      const app = express();
      const failingKeyGen = () => { throw new Error('Auth token decoding crashed'); };
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60_000,
        keyGenerator: failingKeyGen,
        circuitBreaker: { failureThreshold: 2 }
      });

      app.get('/bad-keygen', limiter, (req, res) => res.json({ ok: true }));
      app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

      // Multiple keygen crashes should bubble to next(err), but breaker must NOT trip
      await request(app).get('/bad-keygen');
      await request(app).get('/bad-keygen');
      await request(app).get('/bad-keygen');

      assert.equal(limiter.circuitBreaker.getStats().consecutiveFailures, 0);
      assert.equal(limiter.circuitBreaker.isClosed(), true);
    });

    it('does NOT count dynamic policy evaluation errors as breaker failures', async () => {
      const app = express();
      const failingDynamicLimit = () => { throw new Error('Dynamic policy DB error'); };
      const limiter = rateLimiter({
        limit: failingDynamicLimit,
        windowMs: 60_000,
        circuitBreaker: { failureThreshold: 2 }
      });

      app.get('/bad-dynamic', limiter, (req, res) => res.json({ ok: true }));
      app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

      await request(app).get('/bad-dynamic');
      await request(app).get('/bad-dynamic');

      assert.equal(limiter.circuitBreaker.getStats().consecutiveFailures, 0);
      assert.equal(limiter.circuitBreaker.isClosed(), true);
    });

    it('supports custom isFailure predicate to filter counted errors', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        isFailure: (err) => err.name === 'StoreTimeoutError' // Only timeouts count as failures
      });

      // Regular application error does not count
      await assert.rejects(async () => cb.execute(() => Promise.reject(new Error('User logic error'))));
      assert.equal(cb.getStats().consecutiveFailures, 0);
      assert.equal(cb.isClosed(), true);
    });
  });
});
