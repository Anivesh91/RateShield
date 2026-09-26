import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import {
  rateLimiter,
  MetricsCollector,
  defaultMetricsCollector,
  METRIC_NAMES,
  METRIC_TYPE,
  CIRCUIT_STATE_GAUGE_VALUES,
  DEFAULT_STORE_DURATION_BUCKETS,
  normalizeRoute,
  sanitizePath,
  CircuitBreaker,
  MemoryStore,
  StoreTimeoutError
} from '../src/index.js';

describe('SmartRate v7 — Day 1: Telemetry Foundation & MetricsCollector', () => {

  describe('1. Route Normalization & Cardinality Guard', () => {
    it('sanitizes query parameters from URLs', () => {
      assert.equal(sanitizePath('/api/items?limit=10&page=2'), '/api/items');
    });

    it('sanitizes integer ID segments with :id', () => {
      assert.equal(sanitizePath('/users/42'), '/users/:id');
      assert.equal(sanitizePath('/users/42/posts/101'), '/users/:id/posts/:id');
    });

    it('sanitizes UUID v4 segments with :id', () => {
      assert.equal(
        sanitizePath('/orders/550e8400-e29b-41d4-a716-446655440000/status'),
        '/orders/:id/status'
      );
    });

    it('sanitizes long hex hash strings with :id', () => {
      assert.equal(
        sanitizePath('/tokens/a1b2c3d4e5f60718293a4b5c6d7e8f90'),
        '/tokens/:id'
      );
    });

    it('handles empty, null, or invalid input gracefully', () => {
      assert.equal(sanitizePath(''), '/');
      assert.equal(sanitizePath(null), '/');
      assert.equal(sanitizePath(undefined), '/');
      assert.equal(sanitizePath(123), '/');
    });

    it('prefers req.baseUrl + req.route.path when available from Express router', () => {
      const mockReq = {
        baseUrl: '/api/v1',
        route: { path: '/users/:userId' },
        originalUrl: '/api/v1/users/42'
      };
      assert.equal(normalizeRoute(mockReq), '/api/v1/users/:userId');
    });

    it('falls back to regex sanitization when req.route is not present', () => {
      const mockReq = {
        baseUrl: '',
        path: '/orders/999/items',
        originalUrl: '/orders/999/items'
      };
      assert.equal(normalizeRoute(mockReq), '/orders/:id/items');
    });

    it('delegates to customNormalizer when provided', () => {
      const mockReq = { path: '/custom/path/123' };
      const customNormalizer = (req) => req.path.startsWith('/custom') ? '/custom/normalized' : '/';
      assert.equal(normalizeRoute(mockReq, customNormalizer), '/custom/normalized');
    });

    it('falls back to standard normalization if customNormalizer throws or returns non-string', () => {
      const mockReq = { path: '/users/777' };
      const throwingNormalizer = () => { throw new Error('Boom'); };
      assert.equal(normalizeRoute(mockReq, throwingNormalizer), '/users/:id');

      const nonStringNormalizer = () => null;
      assert.equal(normalizeRoute(mockReq, nonStringNormalizer), '/users/:id');
    });
  });

  describe('2. MetricsCollector Core Unit Semantics', () => {
    let collector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it('initializes with default circuit breaker gauge set to CLOSED (0)', () => {
      const snapshot = collector.getSnapshot();
      assert.ok(snapshot.gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE]);
      const gauge = snapshot.gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE][0];
      assert.equal(gauge.value, CIRCUIT_STATE_GAUGE_VALUES.CLOSED);
    });

    it('increments monotonic counters correctly with default and custom increments', () => {
      collector.incrementCounter('test_counter', { status: 'success' });
      collector.incrementCounter('test_counter', { status: 'success' }, 4);
      collector.incrementCounter('test_counter', { status: 'error' }, 2);

      const snapshot = collector.getSnapshot();
      const records = snapshot.counters.test_counter;
      assert.equal(records.length, 2);

      const successRecord = records.find((r) => r.labels.status === 'success');
      assert.equal(successRecord.value, 5);

      const errorRecord = records.find((r) => r.labels.status === 'error');
      assert.equal(errorRecord.value, 2);
    });

    it('sets instantaneous gauge values and updates existing gauges', () => {
      collector.setGauge('test_gauge', 42, { node: 'node-1' });
      collector.setGauge('test_gauge', 100, { node: 'node-1' });
      collector.setGauge('test_gauge', 25, { node: 'node-2' });

      const snapshot = collector.getSnapshot();
      const records = snapshot.gauges.test_gauge;
      assert.equal(records.length, 2);

      const node1 = records.find((r) => r.labels.node === 'node-1');
      assert.equal(node1.value, 100);

      const node2 = records.find((r) => r.labels.node === 'node-2');
      assert.equal(node2.value, 25);
    });

    it('observes values in cumulative histograms accurately across buckets', () => {
      const customBuckets = [0.005, 0.010, 0.050];
      collector.observeHistogram('test_duration', 0.002, { operation: 'read' }, customBuckets);
      collector.observeHistogram('test_duration', 0.008, { operation: 'read' }, customBuckets);
      collector.observeHistogram('test_duration', 0.040, { operation: 'read' }, customBuckets);

      const snapshot = collector.getSnapshot();
      const records = snapshot.histograms.test_duration;
      assert.equal(records.length, 1);

      const record = records[0];
      assert.equal(record.count, 3);
      assert.ok(Math.abs(record.sum - 0.050) < 1e-6);

      // Buckets:
      // 0.002 <= 0.005 (1), 0.002 <= 0.010 (1), 0.002 <= 0.050 (1)
      // 0.008 <= 0.010 (2), 0.008 <= 0.050 (2)
      // 0.040 <= 0.050 (3)
      assert.equal(record.buckets.find((b) => b.le === 0.005).count, 1);
      assert.equal(record.buckets.find((b) => b.le === 0.010).count, 2);
      assert.equal(record.buckets.find((b) => b.le === 0.050).count, 3);
    });

    it('records high-level domain convenience events', () => {
      collector.recordRequest({
        outcome: 'allowed',
        algorithm: 'sliding-window',
        method: 'GET',
        normalized_route: '/api/v1/users/:id',
        store: 'redis'
      });
      collector.recordStoreError({ store: 'redis', error_type: 'timeout' });
      collector.recordDegradedRequest({ reason: 'circuit_open' });
      collector.recordCircuitBreakerState('OPEN');
      collector.recordStoreDuration(0.0012, { store: 'redis' });

      const snapshot = collector.getSnapshot();

      assert.equal(snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL][0].value, 1);
      assert.equal(snapshot.counters[METRIC_NAMES.STORE_ERRORS_TOTAL][0].value, 1);
      assert.equal(snapshot.counters[METRIC_NAMES.DEGRADED_REQUESTS_TOTAL][0].value, 1);
      assert.equal(
        snapshot.gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE][0].value,
        CIRCUIT_STATE_GAUGE_VALUES.OPEN
      );
      assert.equal(snapshot.histograms[METRIC_NAMES.STORE_DURATION_SECONDS][0].count, 1);
    });

    it('resets all metric state and restores default circuit breaker gauge', () => {
      collector.incrementCounter('reqs', {}, 10);
      collector.recordCircuitBreakerState('OPEN');
      collector.observeHistogram('latency', 0.05);

      collector.reset();

      const snapshot = collector.getSnapshot();
      assert.deepEqual(snapshot.counters, {});
      assert.deepEqual(snapshot.histograms, {});
      assert.equal(
        snapshot.gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE][0].value,
        CIRCUIT_STATE_GAUGE_VALUES.CLOSED
      );
    });

    it('handles unexpected internal errors silently without throwing', () => {
      // Passing invalid data types
      assert.doesNotThrow(() => {
        collector.incrementCounter(null, null, -5);
        collector.setGauge(undefined, 'not-a-number');
        collector.observeHistogram('invalid', -1);
      });
    });
  });

  describe('3. RateLimiter Telemetry Integration Options Validation', () => {
    it('throws TypeError if metrics option is not boolean', () => {
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 1000, metrics: 'yes' }),
        /SmartRate: 'metrics' must be a boolean/
      );
    });

    it('throws TypeError if metricsCollector is not an object with recordRequest', () => {
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 1000, metricsCollector: 'badCollector' }),
        /SmartRate: 'metricsCollector' must be an object implementing a recordRequest\(\) method/
      );
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 1000, metricsCollector: {} }),
        /SmartRate: 'metricsCollector' must be an object implementing a recordRequest\(\) method/
      );
    });

    it('throws TypeError if routeNormalizer is not a function', () => {
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 1000, routeNormalizer: 'not-a-fn' }),
        /SmartRate: 'routeNormalizer' must be a function/
      );
    });
  });

  describe('4. Express Integration — Request Outcomes & Route Cardinality', () => {
    let collector;
    let app;

    beforeEach(() => {
      collector = new MetricsCollector();
      app = express();

      const limiter = rateLimiter({
        limit: 2,
        windowMs: 60000,
        algorithm: 'sliding-window',
        store: new MemoryStore(),
        metricsCollector: collector
      });

      app.get('/api/users/:id', limiter, (req, res) => {
        res.status(200).json({ ok: true, id: req.params.id });
      });
    });

    it('records allowed and blocked request counters with normalized route label', async () => {
      // 1. First request -> 200 OK (allowed)
      const res1 = await request(app).get('/api/users/1001');
      assert.equal(res1.status, 200);

      // 2. Second request -> 200 OK (allowed)
      const res2 = await request(app).get('/api/users/1001');
      assert.equal(res2.status, 200);

      // 3. Third request -> 429 Too Many Requests (blocked)
      const res3 = await request(app).get('/api/users/1001');
      assert.equal(res3.status, 429);

      const snapshot = collector.getSnapshot();
      const reqCounters = snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL];
      assert.ok(reqCounters);

      const allowed = reqCounters.find(
        (r) => r.labels.outcome === 'allowed' && r.labels.normalized_route === '/api/users/:id'
      );
      assert.ok(allowed);
      assert.equal(allowed.value, 2);
      assert.equal(allowed.labels.algorithm, 'sliding-window');
      assert.equal(allowed.labels.method, 'GET');

      const blocked = reqCounters.find(
        (r) => r.labels.outcome === 'blocked' && r.labels.normalized_route === '/api/users/:id'
      );
      assert.ok(blocked);
      assert.equal(blocked.value, 1);

      // Verify store duration histogram recorded 3 observations
      const durationHistograms = snapshot.histograms[METRIC_NAMES.STORE_DURATION_SECONDS];
      assert.ok(durationHistograms);
      assert.equal(durationHistograms[0].count, 3);
    });

    it('uses custom routeNormalizer if provided in options', async () => {
      const customCollector = new MetricsCollector();
      const customApp = express();

      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        metricsCollector: customCollector,
        routeNormalizer: (req) => `/custom-group${req.path.substring(0, 5)}`
      });

      customApp.get('/test/abc', limiter, (req, res) => res.json({ ok: true }));

      await request(customApp).get('/test/abc');

      const snapshot = customCollector.getSnapshot();
      const counter = snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL][0];
      assert.equal(counter.labels.normalized_route, '/custom-group/test');
    });
  });

  describe('5. Express Integration — Failure Modes, Degradation & Circuit Breaker', () => {
    it('records store errors, degradation, and allowed request on fail-open', async () => {
      const collector = new MetricsCollector();
      const app = express();

      const failingStore = {
        async consume() {
          const err = new Error('Connection reset');
          err.code = 'ECONNREFUSED';
          throw err;
        }
      };

      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        store: failingStore,
        onStoreError: 'fail-open',
        metricsCollector: collector
      });

      app.get('/fail-open-test', limiter, (req, res) => res.json({ ok: true }));

      const res = await request(app).get('/fail-open-test');
      assert.equal(res.status, 200);
      assert.equal(res.headers['ratelimit-degraded'], 'true');

      const snapshot = collector.getSnapshot();
      // Store error recorded
      const storeErrors = snapshot.counters[METRIC_NAMES.STORE_ERRORS_TOTAL];
      assert.equal(storeErrors[0].value, 1);
      assert.equal(storeErrors[0].labels.error_type, 'econnrefused');

      // Degraded request recorded
      const degraded = snapshot.counters[METRIC_NAMES.DEGRADED_REQUESTS_TOTAL];
      assert.equal(degraded[0].value, 1);

      // Fail open counts request as allowed
      const reqCounters = snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL];
      assert.equal(reqCounters[0].labels.outcome, 'allowed');
    });

    it('records store errors, degradation, and blocked request on fail-closed', async () => {
      const collector = new MetricsCollector();
      const app = express();

      const timingOutStore = {
        async consume() {
          await new Promise((r) => setTimeout(r, 60));
          return { allowed: true, remaining: 1, reset: 1000, retryAfter: 0 };
        }
      };

      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        store: timingOutStore,
        timeoutMs: 15,
        onStoreError: 'fail-closed',
        metricsCollector: collector
      });

      app.get('/fail-closed-test', limiter, (req, res) => res.json({ ok: true }));

      const res = await request(app).get('/fail-closed-test');
      assert.equal(res.status, 503);
      assert.equal(res.headers['ratelimit-degraded'], 'true');

      const snapshot = collector.getSnapshot();
      const storeErrors = snapshot.counters[METRIC_NAMES.STORE_ERRORS_TOTAL];
      assert.equal(storeErrors[0].value, 1);
      assert.equal(storeErrors[0].labels.error_type, 'timeout');

      const degraded = snapshot.counters[METRIC_NAMES.DEGRADED_REQUESTS_TOTAL];
      assert.equal(degraded[0].value, 1);

      const reqCounters = snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL];
      assert.equal(reqCounters[0].labels.outcome, 'blocked');
    });

    it('updates circuit breaker gauge dynamically during state transitions', async () => {
      const collector = new MetricsCollector();
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 50,
        successThreshold: 1
      });

      const failingStore = {
        async consume() {
          throw new Error('Database down');
        }
      };

      const app = express();
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        store: failingStore,
        circuitBreaker: breaker,
        onStoreError: 'fail-open',
        metricsCollector: collector
      });

      app.get('/circuit-test', limiter, (req, res) => res.json({ ok: true }));

      // Initial state: CLOSED (0)
      assert.equal(
        collector.getSnapshot().gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE][0].value,
        CIRCUIT_STATE_GAUGE_VALUES.CLOSED
      );

      // Trigger 2 failures to trip breaker to OPEN (2)
      await request(app).get('/circuit-test');
      await request(app).get('/circuit-test');

      assert.equal(breaker.isOpen(), true);
      assert.equal(
        collector.getSnapshot().gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE][0].value,
        CIRCUIT_STATE_GAUGE_VALUES.OPEN
      );

      // Wait for resetTimeoutMs so it transitions to HALF_OPEN (1) on next probe
      await new Promise((r) => setTimeout(r, 60));

      // Healthy store for half-open probe
      failingStore.consume = async () => ({ allowed: true, remaining: 4, reset: 1000, retryAfter: 0 });

      await request(app).get('/circuit-test');

      // Now back to CLOSED (0)
      assert.equal(breaker.isClosed(), true);
      assert.equal(
        collector.getSnapshot().gauges[METRIC_NAMES.CIRCUIT_BREAKER_STATE][0].value,
        CIRCUIT_STATE_GAUGE_VALUES.CLOSED
      );
    });

    it('guarantees telemetry failure boundary: telemetry throw never breaks HTTP request', async () => {
      const crashingCollector = {
        recordRequest() {
          throw new Error('Telemetry database disk full');
        },
        recordStoreDuration() {
          throw new Error('Histogram serialization panic');
        },
        recordCircuitBreakerState() {},
        recordStoreError() {},
        recordDegradedRequest() {}
      };

      const app = express();
      const limiter = rateLimiter({
        limit: 10,
        windowMs: 60000,
        metricsCollector: crashingCollector
      });

      app.get('/safe-test', limiter, (req, res) => {
        res.status(200).json({ success: true, message: 'unbroken' });
      });

      const res = await request(app).get('/safe-test');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'unbroken');
    });
  });

  describe('6. Default Singleton Instance Behavior', () => {
    it('uses defaultMetricsCollector when metrics: true is provided', async () => {
      defaultMetricsCollector.reset();

      const app = express();
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        metrics: true
      });

      app.get('/default-metrics-test', limiter, (req, res) => res.json({ ok: true }));

      await request(app).get('/default-metrics-test');

      const snapshot = defaultMetricsCollector.getSnapshot();
      assert.ok(snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL]);
      assert.equal(snapshot.counters[METRIC_NAMES.REQUESTS_TOTAL][0].value, 1);
    });
  });
});
