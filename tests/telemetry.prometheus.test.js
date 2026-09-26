import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import {
  rateLimiter,
  MetricsCollector,
  defaultMetricsCollector,
  createPrometheusExporter,
  formatPrometheusMetrics,
  escapeLabelValue,
  escapeHelpString,
  formatLabels,
  METRIC_NAMES,
  METRIC_TYPE,
  CIRCUIT_STATE_GAUGE_VALUES
} from '../src/index.js';

describe('SmartRate v7 — Day 2: Native Prometheus Text Exposition Format', () => {

  describe('1. Escaping & Label Formatting Utilities', () => {
    it('escapes backslashes, double quotes, and newlines in label values', () => {
      assert.equal(escapeLabelValue('normal_value'), 'normal_value');
      assert.equal(escapeLabelValue('path/with/"quotes"'), 'path/with/\\"quotes\\"');
      assert.equal(escapeLabelValue('line1\nline2'), 'line1\\nline2');
      assert.equal(escapeLabelValue('c:\\windows\\path'), 'c:\\\\windows\\\\path');
      assert.equal(escapeLabelValue(123), '123');
    });

    it('escapes backslashes and newlines in help strings', () => {
      assert.equal(escapeHelpString('Simple help text.'), 'Simple help text.');
      assert.equal(escapeHelpString('Line 1\nLine 2'), 'Line 1\\nLine 2');
      assert.equal(escapeHelpString('C:\\metrics'), 'C:\\\\metrics');
    });

    it('formats labels into deterministic alphabetically sorted key-value pairs', () => {
      assert.equal(formatLabels({}), '');
      assert.equal(formatLabels(null), '');
      assert.equal(formatLabels({ b: '2', a: '1' }), '{a="1",b="2"}');
      assert.equal(
        formatLabels({ route: '/users/:id', method: 'GET' }),
        '{method="GET",route="/users/:id"}'
      );
    });

    it('merges additional labels and filters null or undefined values', () => {
      const base = { store: 'redis', ignored: null, missing: undefined };
      const extra = { le: '0.005' };
      assert.equal(formatLabels(base, extra), '{le="0.005",store="redis"}');
    });
  });

  describe('2. Prometheus Exposition Serializer (formatPrometheusMetrics)', () => {
    it('returns empty string when metrics snapshot is empty', () => {
      assert.equal(formatPrometheusMetrics({}), '');
      assert.equal(formatPrometheusMetrics({ counters: {}, gauges: {}, histograms: {} }), '');
    });

    it('formats counters with HELP, TYPE, and serialized labels', () => {
      const snapshot = {
        counters: {
          [METRIC_NAMES.REQUESTS_TOTAL]: [
            {
              labels: {
                outcome: 'allowed',
                algorithm: 'fixed-window',
                method: 'GET',
                normalized_route: '/api/v1/health',
                store: 'memory'
              },
              value: 12
            }
          ]
        },
        gauges: {},
        histograms: {}
      };

      const output = formatPrometheusMetrics(snapshot);

      assert.ok(output.includes(`# HELP ${METRIC_NAMES.REQUESTS_TOTAL}`));
      assert.ok(output.includes(`# TYPE ${METRIC_NAMES.REQUESTS_TOTAL} counter`));
      assert.ok(
        output.includes(
          'smartrate_requests_total{algorithm="fixed-window",method="GET",normalized_route="/api/v1/health",outcome="allowed",store="memory"} 12'
        )
      );
      assert.ok(output.endsWith('\n'));
    });

    it('formats gauges with HELP, TYPE, and instantaneous numeric value', () => {
      const snapshot = {
        counters: {},
        gauges: {
          [METRIC_NAMES.CIRCUIT_BREAKER_STATE]: [
            {
              labels: {},
              value: CIRCUIT_STATE_GAUGE_VALUES.OPEN
            }
          ]
        },
        histograms: {}
      };

      const output = formatPrometheusMetrics(snapshot);

      assert.ok(output.includes(`# HELP ${METRIC_NAMES.CIRCUIT_BREAKER_STATE}`));
      assert.ok(output.includes(`# TYPE ${METRIC_NAMES.CIRCUIT_BREAKER_STATE} gauge`));
      assert.ok(output.includes('smartrate_circuit_breaker_state 2'));
      assert.ok(output.endsWith('\n'));
    });

    it('formats cumulative histograms with bucket le, +Inf, _sum, and _count', () => {
      const snapshot = {
        counters: {},
        gauges: {},
        histograms: {
          [METRIC_NAMES.STORE_DURATION_SECONDS]: [
            {
              labels: { store: 'redis' },
              buckets: [
                { le: 0.001, count: 2 },
                { le: 0.005, count: 5 }
              ],
              sum: 0.0125,
              count: 5
            }
          ]
        }
      };

      const output = formatPrometheusMetrics(snapshot);

      assert.ok(output.includes(`# HELP ${METRIC_NAMES.STORE_DURATION_SECONDS}`));
      assert.ok(output.includes(`# TYPE ${METRIC_NAMES.STORE_DURATION_SECONDS} histogram`));
      assert.ok(output.includes('smartrate_store_duration_seconds_bucket{le="0.001",store="redis"} 2'));
      assert.ok(output.includes('smartrate_store_duration_seconds_bucket{le="0.005",store="redis"} 5'));
      assert.ok(output.includes('smartrate_store_duration_seconds_bucket{le="+Inf",store="redis"} 5'));
      assert.ok(output.includes('smartrate_store_duration_seconds_sum{store="redis"} 0.0125'));
      assert.ok(output.includes('smartrate_store_duration_seconds_count{store="redis"} 5'));
      assert.ok(output.endsWith('\n'));
    });

    it('provides clean fallbacks for custom user-defined metrics', () => {
      const snapshot = {
        counters: {
          custom_events_total: [
            { labels: { type: 'custom' }, value: 3 }
          ]
        },
        gauges: {},
        histograms: {}
      };

      const output = formatPrometheusMetrics(snapshot);

      assert.ok(output.includes('# HELP custom_events_total Counter metric custom_events_total'));
      assert.ok(output.includes('# TYPE custom_events_total counter'));
      assert.ok(output.includes('custom_events_total{type="custom"} 3'));
    });
  });

  describe('3. Express Prometheus Exporter Middleware Integration', () => {
    let collector;
    let app;

    beforeEach(() => {
      collector = new MetricsCollector();
      app = express();

      const limiter = rateLimiter({
        limit: 2,
        windowMs: 60000,
        algorithm: 'sliding-window',
        metricsCollector: collector
      });

      // API Routes
      app.get('/api/users/:id', limiter, (req, res) => res.json({ id: req.params.id }));
      app.post('/api/checkout', limiter, (req, res) => res.json({ ok: true }));

      // Standard Prometheus scrape endpoint
      app.get('/metrics', createPrometheusExporter({ collector }));
    });

    it('serves Prometheus metrics with the correct HTTP 200 and Content-Type header', async () => {
      const res = await request(app).get('/metrics');
      assert.equal(res.status, 200);
      assert.equal(
        res.headers['content-type'],
        'text/plain; version=0.0.4; charset=utf-8'
      );
      // Circuit breaker default state should be present
      assert.ok(res.text.includes('smartrate_circuit_breaker_state 0'));
    });

    it('scrapes realistic multi-route rate limiting and failure traffic', async () => {
      // 1. Send 2 allowed requests to /api/users/100
      await request(app).get('/api/users/100');
      await request(app).get('/api/users/100');

      // 2. Third request exceeds limit -> 429
      await request(app).get('/api/users/100');

      // 3. Send 1 request to /api/checkout -> 200
      await request(app).post('/api/checkout');

      // 4. Scrape /metrics
      const scrape = await request(app).get('/metrics');
      assert.equal(scrape.status, 200);

      const body = scrape.text;

      // Verify HELP and TYPE headers
      assert.ok(body.includes('# HELP smartrate_requests_total Total number of rate limiter requests evaluated.'));
      assert.ok(body.includes('# TYPE smartrate_requests_total counter'));

      // Verify allowed and blocked metrics with normalized route
      assert.ok(
        body.includes(
          'smartrate_requests_total{algorithm="sliding-window",method="GET",normalized_route="/api/users/:id",outcome="allowed",store="memory"} 2'
        )
      );
      assert.ok(
        body.includes(
          'smartrate_requests_total{algorithm="sliding-window",method="GET",normalized_route="/api/users/:id",outcome="blocked",store="memory"} 1'
        )
      );
      assert.ok(
        body.includes(
          'smartrate_requests_total{algorithm="sliding-window",method="POST",normalized_route="/api/checkout",outcome="allowed",store="memory"} 1'
        )
      );

      // Verify store duration histogram was generated
      assert.ok(body.includes('# TYPE smartrate_store_duration_seconds histogram'));
      assert.ok(body.includes('smartrate_store_duration_seconds_bucket{le="+Inf",store="memory"} 4'));
      assert.ok(body.includes('smartrate_store_duration_seconds_count{store="memory"} 4'));
    });

    it('falls back to defaultMetricsCollector when collector is not explicitly passed', async () => {
      defaultMetricsCollector.reset();

      const defaultApp = express();
      const limiter = rateLimiter({
        limit: 10,
        windowMs: 60000,
        metrics: true
      });

      defaultApp.get('/test-default', limiter, (req, res) => res.json({ ok: true }));
      defaultApp.get('/metrics', createPrometheusExporter());

      await request(defaultApp).get('/test-default');

      const res = await request(defaultApp).get('/metrics');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('smartrate_requests_total'));
      assert.ok(res.text.includes('outcome="allowed"'));
    });

    it('forwards internal exporter errors to Express error handler if something breaks', async () => {
      const brokenApp = express();
      const brokenCollector = {
        getSnapshot() {
          throw new Error('Metrics storage serialization error');
        }
      };

      brokenApp.get('/metrics', createPrometheusExporter({ collector: brokenCollector }));
      // Express error handling middleware
      brokenApp.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(brokenApp).get('/metrics');
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'Metrics storage serialization error');
    });
  });
});
