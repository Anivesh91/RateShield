import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { rateLimiter, MemoryStore } from '../../src/index.js';

const app = express();
const PORT = Number(process.env.DEMO_PORT || 3003);

app.set('trust proxy', true);
app.use(express.json());

const store = new MemoryStore();

// Token Bucket configuration:
// - capacity: 5 (burst capacity)
// - refillRate: 1 token
// - refillIntervalMs: 1000 (1 token per second continuous sustained rate)
const BURST_CAPACITY = 5;
const REFILL_RATE = 1;
const REFILL_INTERVAL_MS = 1000;

app.get(
  '/api/burst',
  rateLimiter({
    algorithm: 'token-bucket',
    capacity: BURST_CAPACITY,
    refillRate: REFILL_RATE,
    refillIntervalMs: REFILL_INTERVAL_MS,
    store
  }),
  (req, res) => {
    res.json({
      success: true,
      message: 'Request allowed under Token Bucket burst quota',
      quota: {
        limit: req.header('ratelimit-limit'),
        remaining: req.header('ratelimit-remaining'),
        reset: req.header('ratelimit-reset')
      },
      timestamp: new Date().toISOString()
    });
  }
);

app.get('/', (req, res) => {
  res.json({
    title: 'SmartRate v5 — Token Bucket + Burst Control Demo',
    description: 'Demonstrates burst tolerance combined with continuous, smooth rate-limiting refill.',
    configuration: {
      algorithm: 'token-bucket',
      capacity: BURST_CAPACITY,
      refillRate: REFILL_RATE,
      refillIntervalMs: REFILL_INTERVAL_MS,
      rule: `${BURST_CAPACITY} requests burst capacity, refilling smoothly at ${REFILL_RATE} token per ${REFILL_INTERVAL_MS}ms`
    },
    endpoints: [
      {
        path: '/api/burst',
        method: 'GET',
        description: 'Enforces Token Bucket rate limiting. Allows bursts up to capacity, then throttles to sustained refill rate with smart Retry-After headers.'
      }
    ],
    curlExample: `curl -i http://localhost:${PORT}/api/burst`
  });
});

const server = app.listen(PORT, async () => {
  console.log(`\n=============================================================`);
  console.log(`🚀 SmartRate v5 — Token Bucket & Burst Control Demo`);
  console.log(`📡 Server listening on http://localhost:${PORT}`);
  console.log(`⚙️  Policy: Capacity = ${BURST_CAPACITY} tokens, Refill = ${REFILL_RATE} token / ${REFILL_INTERVAL_MS}ms`);
  console.log(`=============================================================\n`);

  // Run automated demonstration simulation
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
  console.log(`--- [Stage 1: Firing Rapid Burst of ${BURST_CAPACITY} Requests] ---`);

  for (let i = 1; i <= BURST_CAPACITY; i++) {
    const res = await makeRequest('/api/burst');
    console.log(
      `  Request #${i}: HTTP ${res.status} | Remaining: ${res.headers['ratelimit-remaining']} | Reset (to full): ${res.headers['ratelimit-reset']}s`
    );
  }

  console.log(`\n--- [Stage 2: Burst Exhaustion — Firing Request #${BURST_CAPACITY + 1}] ---`);
  const blocked = await makeRequest('/api/burst');
  console.log(
    `  Request #${BURST_CAPACITY + 1}: HTTP ${blocked.status} (BLOCKED) | Remaining: ${blocked.headers['ratelimit-remaining']} | Retry-After: ${blocked.headers['retry-after']}s | RateLimit-Reset: ${blocked.headers['ratelimit-reset']}s`
  );
  console.log(`  Payload: ${JSON.stringify(blocked.body)}`);

  const retrySec = Number(blocked.headers['retry-after'] || 1);
  console.log(`\n--- [Stage 3: Waiting ${retrySec} second(s) for continuous token refill] ---`);
  await new Promise((resolve) => setTimeout(resolve, retrySec * 1000 + 100));

  console.log(`--- [Stage 4: Client Recovery — Retrying Request #${BURST_CAPACITY + 2}] ---`);
  const recovered = await makeRequest('/api/burst');
  console.log(
    `  Request #${BURST_CAPACITY + 2}: HTTP ${recovered.status} (RECOVERED) | Remaining: ${recovered.headers['ratelimit-remaining']} | Reset (to full): ${recovered.headers['ratelimit-reset']}s`
  );

  console.log(`\n=============================================================`);
  console.log(`✅ Simulation completed! Server remains active on port ${PORT}.`);
  console.log(`👉 Test manually: curl -i http://localhost:${PORT}/api/burst`);
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
