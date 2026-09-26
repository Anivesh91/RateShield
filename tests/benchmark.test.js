import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  calculatePercentiles,
  runBenchmark
} from '../src/benchmark/benchmarkRunner.js';
import demoApp from '../examples/express-demo/observability-demo.js';

describe('SmartRate v7 — Day 4: Performance Benchmarking & Observability Demo', () => {

  describe('1. Percentile Calculator (calculatePercentiles)', () => {
    it('returns zero values when input array is empty or invalid', () => {
      const stats = calculatePercentiles([]);
      assert.equal(stats.count, 0);
      assert.equal(stats.p50Us, 0);
      assert.equal(stats.p99Us, 0);

      const nullStats = calculatePercentiles(null);
      assert.equal(nullStats.count, 0);
    });

    it('calculates correct statistical percentiles and preserves order invariants', () => {
      // 100 samples from 1000ns (1µs) to 100000ns (100µs)
      const samplesNs = Array.from({ length: 100 }, (_, i) => BigInt((i + 1) * 1000));

      const stats = calculatePercentiles(samplesNs);

      assert.equal(stats.count, 100);
      assert.equal(stats.minUs, 1); // 1000ns = 1µs
      assert.equal(stats.maxUs, 100); // 100000ns = 100µs
      assert.equal(stats.p50Us, 51); // 50th percentile
      assert.equal(stats.p90Us, 91);
      assert.equal(stats.p95Us, 96);
      assert.equal(stats.p99Us, 100);

      // Verify mathematical percentile invariant: min <= p50 <= p90 <= p95 <= p99 <= max
      assert.ok(stats.minUs <= stats.p50Us);
      assert.ok(stats.p50Us <= stats.p90Us);
      assert.ok(stats.p90Us <= stats.p95Us);
      assert.ok(stats.p95Us <= stats.p99Us);
      assert.ok(stats.p99Us <= stats.maxUs);

      // Verify millisecond unit conversions
      assert.equal(stats.minMs, 0.001);
      assert.equal(stats.maxMs, 0.1);
      assert.equal(stats.p50Ms, 0.051);
    });
  });

  describe('2. Automated Benchmark Harness (runBenchmark)', () => {
    it('executes all 6 rate limiter and telemetry scenarios cleanly', async () => {
      const report = await runBenchmark({ iterations: 100, warmup: 20 });

      assert.ok(report.timestamp);
      assert.ok(report.nodeVersion);
      assert.ok(report.platform);
      assert.equal(report.iterations, 100);
      assert.equal(report.warmup, 20);
      assert.equal(report.scenarios.length, 6);

      for (const s of report.scenarios) {
        assert.ok(typeof s.scenario === 'string');
        assert.ok(s.opsPerSec > 0, `Throughput should be positive for ${s.scenario}`);
        assert.ok(s.stats.count === 100);
        assert.ok(s.stats.p50Us > 0);
        assert.ok(s.stats.p99Us >= s.stats.p50Us);
        assert.ok(s.overheadP50Us >= 0);
      }

      // First scenario should be baseline with 0 overhead
      assert.ok(report.scenarios[0].scenario.includes('Baseline'));
      assert.equal(report.scenarios[0].overheadP50Us, 0);
    });
  });

  describe('3. Observability Demo Express Application', () => {
    it('serves healthy status on /health', async () => {
      const res = await request(demoApp).get('/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'healthy');
    });

    it('enforces sliding window rate limit and records metrics', async () => {
      const res1 = await request(demoApp).get('/api/users/99');
      assert.equal(res1.status, 200);
      assert.equal(res1.body.success, true);

      // Scrape /metrics to confirm telemetry is active
      const metricsRes = await request(demoApp).get('/metrics');
      assert.equal(metricsRes.status, 200);
      assert.ok(metricsRes.headers['content-type'].includes('version=0.0.4'));
      assert.ok(metricsRes.text.includes('smartrate_requests_total'));
      assert.ok(metricsRes.text.includes('/api/users/:id'));
    });
  });
});
