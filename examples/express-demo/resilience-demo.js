import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import {
  rateLimiter,
  ResilientStore,
  MemoryStore,
  CIRCUIT_STATE
} from '../../src/index.js';

const app = express();
const PORT = Number(process.env.DEMO_PORT || 3004);

app.use(express.json());

// Simulated Distributed Primary Store (mimics Redis with fault injection)
class SimulatedRedisStore {
  constructor() {
    this.healthy = true;
    this.timeoutMode = false;
    this.calls = 0;
    this.state = new Map();
  }

  setHealthy(status) {
    this.healthy = status;
    this.timeoutMode = false;
  }

  setTimeoutMode(status) {
    this.timeoutMode = status;
  }

  async consume(params) {
    this.calls++;

    if (this.timeoutMode) {
      // Simulate extreme network latency triggering timeout guard
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (!this.healthy) {
      throw new Error('Redis connection ECONNREFUSED: 127.0.0.1:6379');
    }

    const { key, limit, windowMs } = params;
    const now = Date.now();
    let record = this.state.get(key);

    if (!record || now >= record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
    }

    if (record.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        reset: Math.ceil(record.resetTime / 1000),
        retryAfter
      };
    }

    record.count++;
    this.state.set(key, record);
    return {
      allowed: true,
      limit,
      remaining: limit - record.count,
      reset: Math.ceil(record.resetTime / 1000),
      retryAfter: 0
    };
  }
}

const simulatedRedis = new SimulatedRedisStore();
const fallbackStore = new MemoryStore();

// Configure ResilientStore with 100ms timeout guard and circuit breaker
const resilientStore = new ResilientStore({
  primaryStore: simulatedRedis,
  fallbackStore,
  timeoutMs: 100,
  failureThreshold: 3,
  resetTimeoutMs: 1200
});

// Event listeners for observability
resilientStore.on('stateChange', (evt) => {
  console.log(`  ⚡ [Breaker Event] State changed: ${evt.from} -> ${evt.to} (reason: ${evt.reason || 'N/A'})`);
});
resilientStore.on('circuitOpen', () => {
  console.log(`  🚨 [Breaker Event] Circuit OPEN! primaryStore bypassed for next ${resilientStore.circuitBreaker.resetTimeoutMs}ms.`);
});
resilientStore.on('probe', () => {
  console.log(`  🔬 [Breaker Event] HALF_OPEN: Dispatching single-flight canary probe to primaryStore...`);
});
resilientStore.on('circuitClose', () => {
  console.log(`  🎉 [Breaker Event] Circuit CLOSED! Primary store verified healthy, traffic recovered.`);
});
resilientStore.on('fallback', (evt) => {
  console.log(`  🛡️  [ResilientStore] Failover active: fallbackStore engaged (Error: ${evt.error.message})`);
});

const DEMO_LIMIT = 4;
const DEMO_WINDOW_MS = 60000;

app.get(
  '/api/resilient',
  rateLimiter({
    store: resilientStore,
    limit: DEMO_LIMIT,
    windowMs: DEMO_WINDOW_MS
  }),
  (req, res) => {
    res.json({
      success: true,
      message: 'Request allowed',
      quota: {
        limit: res.get('ratelimit-limit'),
        remaining: res.get('ratelimit-remaining'),
        reset: res.get('ratelimit-reset'),
        degraded: res.get('ratelimit-degraded') || 'false'
      },
      metadata: req.rateLimit || {},
      circuitState: resilientStore.circuitBreaker.getState()
    });
  }
);

app.get('/', (req, res) => {
  res.json({
    title: 'SmartRate v6 — Production Resilience & Store Fault Tolerance Demo',
    description: 'Demonstrates store timeout protection, circuit breaker, dual-store fallback, safe local degradation, and seamless recovery.',
    configuration: {
      primaryStore: 'SimulatedRedisStore',
      fallbackStore: 'MemoryStore',
      timeoutMs: 100,
      failureThreshold: 3,
      resetTimeoutMs: 1200,
      limit: DEMO_LIMIT,
      windowMs: DEMO_WINDOW_MS
    },
    endpoints: [
      {
        path: '/api/resilient',
        method: 'GET',
        description: 'Enforces rate limits backed by ResilientStore with automatic fallback and degraded tagging.'
      }
    ],
    curlExample: `curl -i http://localhost:${PORT}/api/resilient`
  });
});

const server = app.listen(PORT, async () => {
  console.log(`\n=============================================================`);
  console.log(`🛡️  SmartRate v6 — Production Resilience & Fault Tolerance Demo`);
  console.log(`📡 Server listening on http://localhost:${PORT}`);
  console.log(`⚙️  Store: ResilientStore (Primary: Redis, Fallback: MemoryStore)`);
  console.log(`⚙️  CircuitBreaker: failureThreshold = 3, resetTimeout = 1200ms, timeoutGuard = 100ms`);
  console.log(`=============================================================\n`);

  await runSimulation();
});

async function makeRequest(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
      });
    }).on('error', reject);
  });
}

async function runSimulation() {
  const assertions = [];

  // -------------------------------------------------------------
  // Stage 1: Healthy Primary Redis Operations
  // -------------------------------------------------------------
  console.log(`--- [Stage 1: Healthy Primary Redis Operations (CLOSED)] ---`);
  simulatedRedis.setHealthy(true);

  const resHealthy = await makeRequest('/api/resilient');
  console.log(
    `  Request #1: HTTP ${resHealthy.status} | Store: ${resHealthy.body.circuitState} | Remaining: ${resHealthy.headers['ratelimit-remaining']} | Degraded: ${resHealthy.headers['ratelimit-degraded'] || 'false'}`
  );
  assertions.push({
    name: 'Stage 1 Healthy',
    pass: resHealthy.status === 200 && resHealthy.headers['ratelimit-degraded'] === undefined
  });

  // -------------------------------------------------------------
  // Stage 2: Injecting Store Outage (Simulating Redis Outage)
  // -------------------------------------------------------------
  console.log(`\n--- [Stage 2: Injecting Store Outage (Redis ECONNREFUSED)] ---`);
  simulatedRedis.setHealthy(false);

  // Send 3 requests to accumulate failures and trip the breaker
  for (let i = 1; i <= 3; i++) {
    const resFail = await makeRequest('/api/resilient');
    console.log(
      `  Failure Request #${i}: HTTP ${resFail.status} | Fallback Active | Degraded: ${resFail.headers['ratelimit-degraded']} | Breaker State: ${resFail.body.circuitState}`
    );
    assertions.push({
      name: `Stage 2 Outage Request #${i}`,
      pass: resFail.status === 200 && resFail.headers['ratelimit-degraded'] === 'true'
    });
  }

  // -------------------------------------------------------------
  // Stage 3: Circuit Breaker OPEN (Zero Primary Hammering)
  // -------------------------------------------------------------
  console.log(`\n--- [Stage 3: Circuit Breaker OPEN (Primary Network Calls Bypassed)] ---`);
  const initialCalls = simulatedRedis.calls;

  const resOpen = await makeRequest('/api/resilient');
  const callsDuringOpen = simulatedRedis.calls - initialCalls;

  console.log(
    `  Request while OPEN: HTTP ${resOpen.status} | Breaker: ${resOpen.body.circuitState} | Degraded: ${resOpen.headers['ratelimit-degraded']} | Primary Calls Made: ${callsDuringOpen}`
  );
  assertions.push({
    name: 'Stage 3 Breaker OPEN Zero Hammering',
    pass: resOpen.status === 200 &&
          resOpen.body.circuitState === CIRCUIT_STATE.OPEN &&
          resOpen.headers['ratelimit-degraded'] === 'true' &&
          callsDuringOpen === 0
  });

  // -------------------------------------------------------------
  // Stage 4: Safe Local Rate Limit Enforcement (Quota Exhaustion)
  // -------------------------------------------------------------
  console.log(`\n--- [Stage 4: Safe Local Rate Limit Enforcement (Exhausting Memory Limit)] ---`);
  // Note: During fallback, fallback MemoryStore tracks quota locally.
  // We've used 1 token on fallbackStore so far in this window for this IP.
  // Consume remaining tokens on fallback until blocked.
  let blockedRes = null;
  for (let i = 0; i < 5; i++) {
    const r = await makeRequest('/api/resilient');
    if (r.status === 429) {
      blockedRes = r;
      console.log(
        `  🛑 Local Quota Exhausted: HTTP 429 Too Many Requests | Retry-After: ${r.headers['retry-after']}s | Degraded: ${r.headers['ratelimit-degraded']}`
      );
      break;
    }
  }

  assertions.push({
    name: 'Stage 4 Local Quota 429 Protection',
    pass: blockedRes !== null && blockedRes.status === 429 && blockedRes.headers['ratelimit-degraded'] === 'true'
  });

  // -------------------------------------------------------------
  // Stage 5: Redis Healed, Cooldown Elapsed, Seamless Canary Recovery
  // -------------------------------------------------------------
  console.log(`\n--- [Stage 5: Healing Redis & Waiting 1.3s for Cooldown Expiry] ---`);
  simulatedRedis.setHealthy(true);
  await new Promise((resolve) => setTimeout(resolve, 1300));

  console.log(`--- [Stage 6: Dispatching Canary Probe (HALF_OPEN -> CLOSED)] ---`);
  const resRecovered = await makeRequest('/api/resilient');
  console.log(
    `  Canary Request: HTTP ${resRecovered.status} | Breaker: ${resRecovered.body.circuitState} | Degraded: ${resRecovered.headers['ratelimit-degraded'] || 'false'}`
  );

  assertions.push({
    name: 'Stage 5 Canary Recovery',
    pass: resRecovered.status === 200 &&
          resRecovered.body.circuitState === CIRCUIT_STATE.CLOSED &&
          resRecovered.headers['ratelimit-degraded'] === undefined
  });

  // -------------------------------------------------------------
  // Verification Summary
  // -------------------------------------------------------------
  console.log(`\n=============================================================`);
  let allPassed = true;
  for (const a of assertions) {
    if (a.pass) {
      console.log(`  ✅ ${a.name}: PASSED`);
    } else {
      console.error(`  ❌ ${a.name}: FAILED`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error(`\n❌ Simulation failed assertions.`);
    server.close(() => process.exit(1));
    return;
  }

  console.log(`\n🎉 All Resilience Assertions Verified Successfully!`);
  console.log(`=============================================================\n`);

  if (process.env.DEMO_AUTOCLOSE === 'true') {
    server.close(() => {
      console.log('Automated demo run complete.');
      process.exit(0);
    });
  }
}

function handleShutdown(signal) {
  console.log(`\n[${signal}] Shutting down server gracefully...`);
  server.close(() => {
    console.log('Server shut down cleanly.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
