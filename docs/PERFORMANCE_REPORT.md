# SmartRate V7 — Performance & Overhead Report

> **Real Measurements, Not Marketing Claims.**  
> SmartRate does not claim "zero overhead" or "sub-microsecond Redis calls". Every middleware layer adds execution time. This report documents empirical benchmark results measured using high-precision nanosecond timers (`process.hrtime.bigint()`).

---

## 1. Executive Summary

- **In-Memory Rate Limiting Overhead:**  
  In this run, the fixed-window, sliding-window, and token-bucket MemoryStore scenarios measured **2.3 µs to 3.4 µs** added p50 latency over the no-op middleware baseline.
- **Metrics-Enabled Scenario:**  
  The sliding-window scenario with metrics measured **15.90 µs p50** in this run (**15.60 µs** above the no-op middleware baseline).
- **OpenTelemetry Mock-Span Scenario:**  
  The sliding-window + metrics + OpenTelemetry scenario measured **11.70 µs p50** in this run and sets attributes on a mock span. This is total scenario latency, not a standalone bridge measurement.
- **Maximum Combined In-Process Latency:**  
  The highest p50 among the measured in-memory scenarios was **15.90 µs (0.0159 ms)** in this run. These sequential mock-request measurements are not a production request-latency guarantee.
- **Peak In-Memory Throughput:**  
  The rate-limited MemoryStore scenarios peaked at **232,634 operations/second** per Node.js process in this run. The benchmark invokes middleware sequentially and awaits each call before starting the next, so this is not a heavy-concurrency measurement.

---

## 2. Test Environment & Methodology

- **Runtime:** Node.js v24.11.0
- **Operating System:** Windows 11 (win32 x64)
- **CPUs:** 8 Logical Cores
- **Timing Mechanism:** `process.hrtime.bigint()` (monotonic hardware clock, nanosecond precision)
- **Sample Size:** 10,000 measured requests per scenario
- **Warmup:** 1,000 unmeasured requests per scenario to allow V8 JIT optimization to reach steady-state machine code
- **Cardinality Mode:** Route normalization active (dynamic URL parameters sanitized to `:id`)

---

## 3. Benchmark Results

| Scenario | Throughput (ops/s) | Mean Latency | Median (p50) | 95th %ile (p95) | 99th %ile (p99) | Added p50 vs No-op |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. No-op Middleware** *(Calls `next()` only; no Express server)* | 1,073,514 | 0.42 µs | 0.30 µs | 0.70 µs | 1.00 µs | *baseline* |
| **2. Fixed Window** *(Memory Store)* | 232,634 | 3.95 µs | 3.20 µs | 4.90 µs | 10.20 µs | **+2.90 µs** |
| **3. Sliding Window** *(Memory Store)* | 230,136 | 3.85 µs | 3.70 µs | 5.00 µs | 13.10 µs | **+3.40 µs** |
| **4. Token Bucket** *(Memory Store)* | 226,453 | 4.09 µs | 2.60 µs | 7.30 µs | 12.90 µs | **+2.30 µs** |
| **5. Sliding Window + Metrics** | 45,404 | 21.14 µs | 15.90 µs | 30.10 µs | 87.10 µs | **+15.60 µs** |
| **6. Sliding Window + Metrics + OTel mock span** | 61,027 | 15.92 µs | 11.70 µs | 25.60 µs | 56.50 µs | **+11.40 µs** |

*Note: 1 microsecond (µs) = 0.001 millisecond (ms) = 0.000001 second.*

---

## 4. Overhead Breakdown & Analysis

```
Each row shows that scenario's p50 relative to the no-op middleware result; the differences are not isolated component costs.
No-op Middleware:      [ 0.30 µs ]
Fixed Window:          [ 0.30 µs ] + [ 2.90 µs ]
Sliding Window:        [ 0.30 µs ] + [ 3.40 µs ]
Token Bucket:          [ 0.30 µs ] + [ 2.30 µs ]
With Metrics:          [ 0.30 µs ] + [ 15.60 µs ]
With Metrics + OTel:   [ 0.30 µs ] + [ 11.40 µs ]
```

### Why Token Bucket & Sliding Window Are Highly Performant
- **Token Bucket (`2.60 µs` p50):**  
  Uses an atomic timestamp and token float math calculation on each request. It does not iterate over arrays or allocate dynamic structures per request once initialized.
- **Sliding Window (`3.70 µs` p50):**  
  Maintains in-memory circular timestamp buffers with rolling boundary eviction.
- **Route Normalization (`< 1 µs`):**  
  Leverages Express's internal route pattern table (`req.baseUrl + req.route.path`), avoiding regex evaluation for standard matched routes.

### Metrics-Enabled Scenario (`15.90 µs` p50)
The in-memory `MetricsCollector`:
- Reads high-resolution hardware timestamps (`process.hrtime.bigint()`).
- Normalizes label maps into serialized lookup keys.
- Updates cumulative histogram bounds and increments monotonic counters.
- Strictly bounds memory to prevent garbage collection spikes.

### OpenTelemetry Mock-Span Scenario (`11.70 µs` p50)
This scenario includes sliding-window rate limiting, metrics, and `OpenTelemetryBridge` attribute calls on a mock span. Its p50 is the total scenario latency and does not isolate the bridge's incremental cost.

---

## 5. In-Memory vs Distributed Redis Latency

### Measured MemoryStore Results

The in-process p50 figures below are measured by this report's sequential benchmark; they do not include Redis network calls.

| MemoryStore Scenario | Measured p50 |
| :--- | :---: |
| **Fixed Window** | 3.20 µs |
| **Sliding Window** | 3.70 µs |
| **Token Bucket** | 2.60 µs |
| **Sliding Window + Metrics** | 15.90 µs |
| **Sliding Window + Metrics + mock-span attributes** | 11.70 µs |

### Estimated Redis Latency (Not Benchmarked Here)

The following Redis values are estimates, not results from this benchmark. They assume a same-VPC Redis network round-trip of **300–1,000 µs** and Lua execution of **100–250 µs**, combined with the measured fixed-window, sliding-window, and token-bucket MemoryStore p50 range above (**2.60–3.70 µs**) as a rough proxy for local middleware work. The percentage ranges are estimated by dividing each component's range by the sum of component ranges; their extrema need not occur in the same scenario.

| Redis Component | Estimated Latency | Estimated Fraction of Total |
| :--- | :---: | :---: |
| **SmartRate In-Process Execution** *(measured MemoryStore p50 used as proxy)* | 2.60–3.70 µs | ~0.2–0.9% |
| **Redis Network Round-Trip Time** *(assumed same-VPC range)* | 300–1,000 µs | ~54–91% |
| **Redis Lua Script Execution** *(assumed range)* | 100–250 µs | ~9–45% |
| **Estimated Total Redis Rate Limit Check** | **402.6 µs–1.254 ms** | **100%** |

**Engineering Insight:**  
Under these assumptions, network and Redis execution dominate the total. Actual latency depends on deployment topology, Redis load, and client behavior and should be measured in the target environment.

---

## 6. Memory Cardinality Guard

Uncontrolled Prometheus label cardinality is a common cause of production memory outages.  
SmartRate enforces strict label hygiene:

1. **Never Label User IDs or IPs:**  
   Client identifiers (`req.ip`, API Keys, JWT sub) are hashed into the rate limit storage key, but **never** placed into Prometheus metric labels.
2. **Normalized Routes:**  
   `/users/98231` and `/users/44120` both collapse to `/users/:id`. The cardinality of `smartrate_requests_total` is bounded by `routes × methods × outcomes × stores` (typically < 200 metric series total).
3. **Bounded Histogram Buckets:**  
   Default buckets are capped at 11 fixed thresholds calibrated for microsecond-to-second store latencies.

---

## 7. How to Reproduce

You can reproduce this benchmark on your own server or CI pipeline:

```bash
# Clone the repository
git clone https://github.com/Anivesh91/RateShield.git
cd RateShield

# Run benchmark suite
npm run benchmark
```
