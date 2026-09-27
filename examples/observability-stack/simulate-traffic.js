/**
 * SmartRate V7 — Automated Observability Traffic Simulator
 *
 * Runs realistic multi-stage traffic against the SmartRate server:
 * 1. Steady Baseline Traffic (200 OKs)
 * 2. Rate-Limiting Burst (429 Too Many Requests)
 * 3. Chaos Injection (Redis failure -> Degraded fallback & Circuit Breaker trip)
 * 4. Recovery & Health (Canary probe -> Circuit Breaker recovery)
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRequest(path, method = 'GET', body = null) {
  try {
    const options = { method, headers: {} };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const start = Date.now();
    const res = await fetch(`${BASE_URL}${path}`, options);
    const duration = Date.now() - start;
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return {
      status: res.status,
      duration,
      degraded: res.headers.get('ratelimit-degraded') === 'true',
      remaining: res.headers.get('ratelimit-remaining'),
      reset: res.headers.get('ratelimit-reset'),
      retryAfter: res.headers.get('retry-after'),
      data
    };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

async function runSimulation() {
  console.log('================================================================================');
  console.log(`   SmartRate V7 Observability Traffic Simulator`);
  console.log(`   Target: ${BASE_URL}`);
  console.log('================================================================================\n');

  // Verify server reachability
  const health = await makeRequest('/health');
  if (health.status !== 200) {
    console.error(`[ERROR] Server at ${BASE_URL} is unreachable. Ensure the server is running.`);
    process.exit(1);
  }
  console.log('[OK] Connected to SmartRate demo server.\n');

  // ---------------------------------------------------------------------------
  // STAGE 1: Steady Baseline Traffic
  // ---------------------------------------------------------------------------
  console.log('>>> STAGE 1: Steady Baseline Traffic (10 requests to /api/public and /api/users/:id)');
  for (let i = 1; i <= 5; i++) {
    const r1 = await makeRequest('/api/public');
    const r2 = await makeRequest(`/api/users/${i}`);
    console.log(`  [200 OK] /api/public (rem: ${r1.remaining}) | /api/users/${i} (rem: ${r2.remaining})`);
    await sleep(200);
  }
  console.log('  Stage 1 completed.\n');

  // ---------------------------------------------------------------------------
  // STAGE 2: Quota Burst -> 429 RateLimit Exceeded
  // ---------------------------------------------------------------------------
  console.log('>>> STAGE 2: Quota Burst (Sending 12 rapid requests to /api/users/99)');
  for (let i = 1; i <= 12; i++) {
    const res = await makeRequest('/api/users/99');
    if (res.status === 200) {
      console.log(`  Req #${i}: 200 OK (Remaining: ${res.remaining})`);
    } else if (res.status === 429) {
      console.log(`  Req #${i}: 429 Too Many Requests (Retry-After: ${res.retryAfter}s) -> RateLimit Exceeded Alert Target`);
    }
    await sleep(50);
  }
  console.log('  Stage 2 completed.\n');

  // ---------------------------------------------------------------------------
  // STAGE 3: Chaos Injection -> Store Outage & Circuit Breaker Trip
  // ---------------------------------------------------------------------------
  console.log('>>> STAGE 3: Chaos Injection (Simulating Redis outage)');
  await makeRequest('/api/chaos/break-store', 'POST');
  console.log('  Chaos active: Primary Redis store forced to ECONNREFUSED.');

  for (let i = 1; i <= 6; i++) {
    const res = await makeRequest('/api/public');
    console.log(`  Req #${i}: ${res.status} OK (Degraded: ${res.degraded}) -> Served by Memory fallback`);
    await sleep(100);
  }

  const breakerCheck = await makeRequest('/health');
  console.log(`  Circuit Breaker State: ${breakerCheck.data?.circuitBreaker?.state || 'OPEN'}`);
  console.log('  Stage 3 completed: smartrate_store_errors_total & circuit_breaker_state recorded.\n');

  // ---------------------------------------------------------------------------
  // STAGE 4: Recovery -> Heal Store & Canary Probe
  // ---------------------------------------------------------------------------
  console.log('>>> STAGE 4: Store Recovery (Restoring Redis)');
  await makeRequest('/api/chaos/heal-store', 'POST');
  console.log('  Chaos deactivated: Primary store restored.');
  console.log('  Waiting 10s for Circuit Breaker resetTimeoutMs to transition to HALF_OPEN...');
  await sleep(10500);

  console.log('  Sending canary probe request...');
  const probeRes = await makeRequest('/api/public');
  console.log(`  Canary Response: ${probeRes.status} OK (Degraded: ${probeRes.degraded})`);

  const recoveredHealth = await makeRequest('/health');
  console.log(`  Circuit Breaker Recovered State: ${recoveredHealth.data?.circuitBreaker?.state || 'CLOSED'}`);
  console.log('  Stage 4 completed.\n');

  // ---------------------------------------------------------------------------
  // STAGE 5: Metrics Scrape Verification
  // ---------------------------------------------------------------------------
  console.log('>>> STAGE 5: Prometheus Scrape Verification');
  const metricsRes = await fetch(`${BASE_URL}/metrics`);
  const metricsText = await metricsRes.text();
  console.log(`  /metrics response length: ${metricsText.length} bytes`);
  console.log('  Sample Prometheus lines:');
  const sampleLines = metricsText
    .split('\n')
    .filter((l) => l.startsWith('smartrate_') && !l.startsWith('#'))
    .slice(0, 8);
  for (const line of sampleLines) {
    console.log(`    ${line}`);
  }

  console.log('\n================================================================================');
  console.log('   Simulation Complete! Check Grafana at http://localhost:3001');
  console.log('================================================================================\n');
}

runSimulation().catch(console.error);
