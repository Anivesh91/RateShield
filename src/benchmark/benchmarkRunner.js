import { rateLimiter } from '../limiter/rateLimiter.js';
import { MemoryStore } from '../stores/memoryStore.js';
import { MetricsCollector } from '../telemetry/metricsCollector.js';
import { OpenTelemetryBridge } from '../telemetry/openTelemetryBridge.js';

/**
 * Calculates statistical percentiles and summary metrics from an array of nanosecond durations.
 *
 * @param {bigint[]|number[]} samplesNs - Latency durations in nanoseconds
 * @returns {Object} Calculated metrics in microseconds and milliseconds
 */
export function calculatePercentiles(samplesNs) {
  if (!Array.isArray(samplesNs) || samplesNs.length === 0) {
    return {
      count: 0,
      minUs: 0,
      maxUs: 0,
      meanUs: 0,
      p50Us: 0,
      p90Us: 0,
      p95Us: 0,
      p99Us: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0
    };
  }

  // Convert to numbers in microseconds for accurate floating-point math
  const samplesUs = samplesNs
    .map((ns) => (typeof ns === 'bigint' ? Number(ns) / 1000 : Number(ns) / 1000))
    .sort((a, b) => a - b);

  const count = samplesUs.length;
  const sumUs = samplesUs.reduce((acc, val) => acc + val, 0);
  const meanUs = sumUs / count;

  const getPercentile = (p) => {
    const idx = Math.min(count - 1, Math.max(0, Math.floor((p / 100) * count)));
    return samplesUs[idx];
  };

  const minUs = samplesUs[0];
  const maxUs = samplesUs[count - 1];
  const p50Us = getPercentile(50);
  const p90Us = getPercentile(90);
  const p95Us = getPercentile(95);
  const p99Us = getPercentile(99);

  return {
    count,
    minUs: Number(minUs.toFixed(2)),
    maxUs: Number(maxUs.toFixed(2)),
    meanUs: Number(meanUs.toFixed(2)),
    p50Us: Number(p50Us.toFixed(2)),
    p90Us: Number(p90Us.toFixed(2)),
    p95Us: Number(p95Us.toFixed(2)),
    p99Us: Number(p99Us.toFixed(2)),
    minMs: Number((minUs / 1000).toFixed(4)),
    maxMs: Number((maxUs / 1000).toFixed(4)),
    meanMs: Number((meanUs / 1000).toFixed(4)),
    p50Ms: Number((p50Us / 1000).toFixed(4)),
    p90Ms: Number((p90Us / 1000).toFixed(4)),
    p95Ms: Number((p95Us / 1000).toFixed(4)),
    p99Ms: Number((p99Us / 1000).toFixed(4))
  };
}

/**
 * Creates a mock Express request and response object pair.
 *
 * @param {string} ip
 * @param {string} path
 * @param {string} [method='GET']
 * @returns {{ req: Object, res: Object }}
 */
function createMockHttpPair(ip = '192.168.1.1', path = '/api/resource', method = 'GET') {
  const req = {
    method,
    originalUrl: path,
    path,
    ip,
    headers: { host: 'localhost:3000' },
    socket: { remoteAddress: ip }
  };

  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      headers[name.toLowerCase()] = String(value);
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };

  return { req, res };
}

/**
 * Runs a performance benchmark across all SmartRate rate limiting algorithms and telemetry configurations.
 *
 * @param {Object} [options={}]
 * @param {number} [options.iterations=10000] - Number of measurement requests per scenario
 * @param {number} [options.warmup=1000] - Number of unmeasured warmup requests to prime V8 JIT
 * @returns {Promise<Object>} Benchmark results
 */
export async function runBenchmark(options = {}) {
  const iterations = options.iterations || 10000;
  const warmup = options.warmup || 1000;

  // Next function stub
  const nextStub = () => {};

  // Define scenarios
  const scenarios = [
    {
      name: '1. Express Baseline (No Rate Limiting)',
      middleware: (req, res, next) => next()
    },
    {
      name: '2. Fixed Window (Memory Store)',
      middleware: rateLimiter({
        limit: 1000000,
        windowMs: 60000,
        algorithm: 'fixed-window',
        store: new MemoryStore()
      })
    },
    {
      name: '3. Sliding Window (Memory Store)',
      middleware: rateLimiter({
        limit: 1000000,
        windowMs: 60000,
        algorithm: 'sliding-window',
        store: new MemoryStore()
      })
    },
    {
      name: '4. Token Bucket (Memory Store)',
      middleware: rateLimiter({
        capacity: 1000000,
        refillRate: 100000,
        algorithm: 'token-bucket',
        store: new MemoryStore()
      })
    },
    {
      name: '5. Sliding Window + Metrics (Telemetry Enabled)',
      middleware: rateLimiter({
        limit: 1000000,
        windowMs: 60000,
        algorithm: 'sliding-window',
        store: new MemoryStore(),
        metricsCollector: new MetricsCollector()
      })
    },
    {
      name: '6. Sliding Window + Metrics + OpenTelemetry Bridge',
      middleware: rateLimiter({
        limit: 1000000,
        windowMs: 60000,
        algorithm: 'sliding-window',
        store: new MemoryStore(),
        metricsCollector: new MetricsCollector(),
        openTelemetry: new OpenTelemetryBridge({
          getSpan: (req) => req.span
        })
      })
    }
  ];

  const results = [];

  for (const scenario of scenarios) {
    const mockSpan = {
      attributes: {},
      events: [],
      setAttribute(k, v) { this.attributes[k] = v; },
      addEvent(name, attrs) { this.events.push({ name, attrs }); }
    };

    // Warmup phase (let V8 JIT compile hot paths)
    for (let i = 0; i < warmup; i++) {
      const { req, res } = createMockHttpPair(`10.0.0.${(i % 50) + 1}`, '/api/benchmark');
      req.span = mockSpan;
      await scenario.middleware(req, res, nextStub);
    }

    // Measurement phase
    const samplesNs = [];
    const totalStart = process.hrtime.bigint();

    for (let i = 0; i < iterations; i++) {
      const { req, res } = createMockHttpPair(`10.0.0.${(i % 100) + 1}`, '/api/benchmark');
      req.span = mockSpan;

      const start = process.hrtime.bigint();
      await scenario.middleware(req, res, nextStub);
      const durationNs = process.hrtime.bigint() - start;

      samplesNs.push(durationNs);
    }

    const totalElapsedNs = process.hrtime.bigint() - totalStart;
    const totalElapsedSec = Number(totalElapsedNs) / 1e9;
    const opsPerSec = Math.round(iterations / totalElapsedSec);

    const stats = calculatePercentiles(samplesNs);

    results.push({
      scenario: scenario.name,
      iterations,
      opsPerSec,
      stats
    });
  }

  // Calculate relative overhead against baseline
  const baselineStats = results[0].stats;

  const enrichedResults = results.map((r, idx) => {
    if (idx === 0) {
      return { ...r, overheadP50Us: 0, overheadP99Us: 0 };
    }
    const overheadP50Us = Number((r.stats.p50Us - baselineStats.p50Us).toFixed(2));
    const overheadP99Us = Number((r.stats.p99Us - baselineStats.p99Us).toFixed(2));
    return {
      ...r,
      overheadP50Us: Math.max(0, overheadP50Us),
      overheadP99Us: Math.max(0, overheadP99Us)
    };
  });

  return {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    iterations,
    warmup,
    scenarios: enrichedResults
  };
}
