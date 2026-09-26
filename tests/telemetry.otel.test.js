import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import express from 'express';
import {
  rateLimiter,
  OpenTelemetryBridge,
  StoreTimeoutError,
  CircuitBreakerOpenError
} from '../src/index.js';

describe('SmartRate v7 — Day 3: OpenTelemetry Bridge, Alerting Rules & Grafana Dashboard', () => {

  describe('1. OpenTelemetryBridge Unit Semantics', () => {
    let mockSpan;
    let bridge;

    beforeEach(() => {
      mockSpan = {
        attributes: {},
        events: [],
        exceptions: [],
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        addEvent(name, attrs = {}) {
          this.events.push({ name, attrs });
        },
        recordException(err) {
          this.exceptions.push(err);
        }
      };

      bridge = new OpenTelemetryBridge();
    });

    it('resolves active span from req.span', () => {
      const req = { span: mockSpan };
      assert.equal(bridge.resolveSpan(req), mockSpan);
    });

    it('resolves active span via custom getSpan function', () => {
      const customBridge = new OpenTelemetryBridge({
        getSpan: (req) => req.customContext?.activeSpan
      });

      const req = { customContext: { activeSpan: mockSpan } };
      assert.equal(customBridge.resolveSpan(req), mockSpan);
    });

    it('safely handles errors in custom getSpan without throwing', () => {
      const crashingBridge = new OpenTelemetryBridge({
        getSpan: () => { throw new Error('Tracer context lost'); }
      });

      assert.equal(crashingBridge.resolveSpan({}), null);
    });

    it('records attributes on span for allowed requests', () => {
      const req = { span: mockSpan };
      bridge.recordEvaluation({
        req,
        result: { allowed: true, remaining: 9, reset: 60, retryAfter: 0 },
        algorithm: 'token-bucket',
        normalizedRoute: '/api/v1/checkout',
        store: 'redis'
      });

      assert.equal(mockSpan.attributes['smartrate.outcome'], 'allowed');
      assert.equal(mockSpan.attributes['smartrate.algorithm'], 'token-bucket');
      assert.equal(mockSpan.attributes['smartrate.route'], '/api/v1/checkout');
      assert.equal(mockSpan.attributes['smartrate.store'], 'redis');
      assert.equal(mockSpan.attributes['smartrate.remaining'], 9);
      assert.equal(mockSpan.attributes['smartrate.reset'], 60);
      assert.equal(mockSpan.events.length, 0);
    });

    it('records attributes and rate_limit_exceeded event on span for blocked requests', () => {
      const req = { span: mockSpan };
      bridge.recordEvaluation({
        req,
        result: { allowed: false, remaining: 0, reset: 15, retryAfter: 15 },
        algorithm: 'sliding-window',
        normalizedRoute: '/api/v1/login',
        store: 'memory'
      });

      assert.equal(mockSpan.attributes['smartrate.outcome'], 'blocked');
      assert.equal(mockSpan.attributes['smartrate.algorithm'], 'sliding-window');
      assert.equal(mockSpan.attributes['smartrate.route'], '/api/v1/login');
      assert.equal(mockSpan.attributes['smartrate.remaining'], 0);
      assert.equal(mockSpan.attributes['smartrate.reset'], 15);

      assert.equal(mockSpan.events.length, 1);
      assert.equal(mockSpan.events[0].name, 'smartrate.rate_limit_exceeded');
      assert.equal(mockSpan.events[0].attrs['smartrate.retry_after'], 15);
      assert.equal(mockSpan.events[0].attrs['smartrate.route'], '/api/v1/login');
    });

    it('records exceptions and store_error event on span for store errors', () => {
      const req = { span: mockSpan };
      const err = new StoreTimeoutError(250, 'Redis store timed out');

      bridge.recordStoreError({
        req,
        storeError: err,
        store: 'redis'
      });

      assert.equal(mockSpan.attributes['smartrate.store_error'], true);
      assert.equal(mockSpan.attributes['smartrate.store'], 'redis');
      assert.equal(mockSpan.exceptions.length, 1);
      assert.equal(mockSpan.exceptions[0], err);

      assert.equal(mockSpan.events.length, 1);
      assert.equal(mockSpan.events[0].name, 'smartrate.store_error');
      assert.equal(mockSpan.events[0].attrs['error.name'], 'StoreTimeoutError');
    });

    it('guarantees zero failure disruption when span methods throw', () => {
      const throwingSpan = {
        setAttribute() { throw new Error('Span closed'); },
        addEvent() { throw new Error('Span buffer full'); },
        recordException() { throw new Error('OTel recorder crash'); }
      };

      const req = { span: throwingSpan };

      assert.doesNotThrow(() => {
        bridge.recordEvaluation({
          req,
          result: { allowed: false, remaining: 0, reset: 10, retryAfter: 10 },
          algorithm: 'fixed-window',
          normalizedRoute: '/test',
          store: 'memory'
        });

        bridge.recordStoreError({
          req,
          storeError: new Error('Disk error'),
          store: 'memory'
        });
      });
    });
  });

  describe('2. RateLimiter Middleware OpenTelemetry Integration', () => {
    it('validates openTelemetry option types fail-fast', () => {
      assert.throws(
        () => rateLimiter({ limit: 5, windowMs: 1000, openTelemetry: 'bad-option' }),
        /SmartRate: 'openTelemetry' must be a boolean, an options object, or an OpenTelemetryBridge instance/
      );
    });

    it('attaches telemetry attributes to span on allowed and blocked requests in Express', async () => {
      let capturedSpan;

      const app = express();
      const limiter = rateLimiter({
        limit: 1,
        windowMs: 60000,
        openTelemetry: true
      });

      // Simulated OpenTelemetry span injection middleware
      app.use((req, res, next) => {
        capturedSpan = {
          attributes: {},
          events: [],
          setAttribute(k, v) { this.attributes[k] = v; },
          addEvent(name, attrs) { this.events.push({ name, attrs }); }
        };
        req.span = capturedSpan;
        next();
      });

      app.get('/api/resource/:id', limiter, (req, res) => res.json({ ok: true }));

      // Request 1: Allowed
      const res1 = await request(app).get('/api/resource/42');
      assert.equal(res1.status, 200);
      assert.equal(capturedSpan.attributes['smartrate.outcome'], 'allowed');
      assert.equal(capturedSpan.attributes['smartrate.route'], '/api/resource/:id');

      // Request 2: Blocked (429)
      const res2 = await request(app).get('/api/resource/42');
      assert.equal(res2.status, 429);
      assert.equal(capturedSpan.attributes['smartrate.outcome'], 'blocked');
      assert.equal(capturedSpan.events.length, 1);
      assert.equal(capturedSpan.events[0].name, 'smartrate.rate_limit_exceeded');
    });

    it('attaches store error to span when rate limit store fails', async () => {
      let capturedSpan;

      const failingStore = {
        async consume() {
          throw new Error('Connection refused to redis cluster');
        }
      };

      const app = express();
      const limiter = rateLimiter({
        limit: 5,
        windowMs: 60000,
        store: failingStore,
        onStoreError: 'fail-open',
        openTelemetry: true
      });

      app.use((req, res, next) => {
        capturedSpan = {
          attributes: {},
          events: [],
          exceptions: [],
          setAttribute(k, v) { this.attributes[k] = v; },
          addEvent(name, attrs) { this.events.push({ name, attrs }); },
          recordException(err) { this.exceptions.push(err); }
        };
        req.span = capturedSpan;
        next();
      });

      app.get('/failover-test', limiter, (req, res) => res.json({ ok: true }));

      const res = await request(app).get('/failover-test');
      assert.equal(res.status, 200);
      assert.equal(capturedSpan.attributes['smartrate.store_error'], true);
      assert.equal(capturedSpan.exceptions.length, 1);
      assert.equal(capturedSpan.exceptions[0].message, 'Connection refused to redis cluster');
    });
  });

  describe('3. Production Alerting Rules & Grafana Dashboard Asset Verification', () => {
    it('verifies prometheus-rules.yml exists and contains all required alerts', () => {
      const alertFilePath = path.resolve('assets/alerts/prometheus-rules.yml');
      assert.ok(fs.existsSync(alertFilePath), 'prometheus-rules.yml must exist');

      const content = fs.readFileSync(alertFilePath, 'utf8');

      // Check required alert rules
      const requiredAlerts = [
        'SmartRateHighBlockRate',
        'SmartRateStoreOutage',
        'SmartRateCircuitBreakerOpen',
        'SmartRateElevatedStoreLatency',
        'SmartRateHighDegradedTraffic'
      ];

      for (const alert of requiredAlerts) {
        assert.ok(
          content.includes(`alert: ${alert}`),
          `Missing expected alert definition: ${alert}`
        );
      }

      // Check metric names referenced
      assert.ok(content.includes('smartrate_requests_total'));
      assert.ok(content.includes('smartrate_store_errors_total'));
      assert.ok(content.includes('smartrate_circuit_breaker_state'));
      assert.ok(content.includes('smartrate_store_duration_seconds_bucket'));
      assert.ok(content.includes('smartrate_degraded_requests_total'));
    });

    it('verifies smartrate-grafana-dashboard.json is valid JSON with essential panels', () => {
      const dashboardPath = path.resolve('assets/dashboards/smartrate-grafana-dashboard.json');
      assert.ok(fs.existsSync(dashboardPath), 'smartrate-grafana-dashboard.json must exist');

      const raw = fs.readFileSync(dashboardPath, 'utf8');
      let dashboard;
      assert.doesNotThrow(() => {
        dashboard = JSON.parse(raw);
      }, 'Dashboard must be valid JSON');

      assert.equal(dashboard.uid, 'smartrate-v7-overview');
      assert.equal(dashboard.title, 'SmartRate — Observability & Health');
      assert.ok(Array.isArray(dashboard.panels));
      assert.ok(dashboard.panels.length >= 6);

      // Verify panel titles cover key observability facets
      const panelTitles = dashboard.panels.map((p) => p.title);
      assert.ok(panelTitles.some((t) => t.includes('Throughput')));
      assert.ok(panelTitles.some((t) => t.includes('Block Rate')));
      assert.ok(panelTitles.some((t) => t.includes('Circuit Breaker')));
      assert.ok(panelTitles.some((t) => t.includes('Store Operation Latency')));
      assert.ok(panelTitles.some((t) => t.includes('Store Errors')));
      assert.ok(panelTitles.some((t) => t.includes('Route Traffic Breakdown')));
    });
  });
});
