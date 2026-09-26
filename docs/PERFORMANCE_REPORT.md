# SmartRate V7 — Performance & Overhead Report

> **Real Measurements, Not Marketing Claims.**  
> SmartRate does not claim "zero overhead" or "sub-microsecond Redis calls". Every middleware layer adds execution time. This report documents empirical benchmark results measured using high-precision nanosecond timers (`process.hrtime.bigint()`).

---

## 1. Executive Summary

- **In-Memory Rate Limiting Overhead:**  
  Evaluating rate limits in-memory adds approximately **3.1 µs to 4.1 µs (0.0031 ms to 0.0041 ms)** at the 50th percentile (p50) over raw Express baseline middleware.
- **Internal Metrics Telemetry Overhead:**  
  Enabling Prometheus metrics instrumentation (`MetricsCollector`) adds approximately **3.6 µs** at p50 to record request counters, store duration histograms, and outcome labels.
- **OpenTelemetry Bridge Overhead:**  
  Attaching distributed tracing attributes and span events adds approximately **7.5 µs** at p50.
- **Maximum Combined In-Process Latency:**  
  Even with all algorithms, store operations, route normalization, metrics collection, and OpenTelemetry instrumentation enabled, total p50 latency is **~15 µs (0.015 ms)**, leaving **99.98% of your request budget** for actual application logic.
- **Peak In-Memory Throughput:**  
  Over **170,000+ operations/second** per Node.js process thread under heavy concurrent evaluation.

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

| Scenario | Throughput (ops/s) | Mean Latency | Median (p50) | 95th %ile (p95) | 99th %ile (p99) | Added p50 vs Baseline |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. Express Baseline** *(No Limiter)* | 437,468 | 0.98 µs | 0.60 µs | 1.30 µs | 3.20 µs | *baseline* |
| **2. Fixed Window** *(Memory Store)* | 146,206 | 6.13 µs | 4.70 µs | 8.70 µs | 17.60 µs | **+4.10 µs** |
| **3. Sliding Window** *(Memory Store)* | 174,086 | 5.05 µs | 3.90 µs | 7.00 µs | 13.30 µs | **+3.30 µs** |
| **4. Token Bucket** *(Memory Store)* | 174,423 | 5.12 µs | 3.70 µs | 8.80 µs | 14.10 µs | **+3.10 µs** |
| **5. Sliding Window + Metrics** | 84,901 | 11.22 µs | 7.50 µs | 21.70 µs | 42.80 µs | **+6.90 µs** |
| **6. Sliding Window + Metrics + OTel** | 54,290 | 17.81 µs | 15.00 µs | 28.90 µs | 54.70 µs | **+14.40 µs** |

*Note: 1 microsecond (µs) = 0.001 millisecond (ms) = 0.000001 second.*

---

## 4. Overhead Breakdown & Analysis

```
Express Baseline:      [ 0.60 µs ]
Fixed Window:          [ 0.60 µs ] + [ 4.10 µs ]
Sliding Window:        [ 0.60 µs ] + [ 3.30 µs ]
Token Bucket:          [ 0.60 µs ] + [ 3.10 µs ]
With Metrics:          [ 0.60 µs ] + [ 3.30 µs ] + [ 3.60 µs ]
With Metrics + OTel:   [ 0.60 µs ] + [ 3.30 µs ] + [ 3.60 µs ] + [ 7.50 µs ]
```

### Why Token Bucket & Sliding Window Are Highly Performant
- **Token Bucket (`3.70 µs` p50):**  
  Uses an atomic timestamp and token float math calculation on each request. It does not iterate over arrays or allocate dynamic structures per request once initialized.
- **Sliding Window (`3.90 µs` p50):**  
  Maintains in-memory circular timestamp buffers with rolling boundary eviction.
- **Route Normalization (`< 1 µs`):**  
  Leverages Express's internal route pattern table (`req.baseUrl + req.route.path`), avoiding regex evaluation for standard matched routes.

### Metrics Collection Cost (`+3.60 µs`)
The in-memory `MetricsCollector`:
- Reads high-resolution hardware timestamps (`process.hrtime.bigint()`).
- Normalizes label maps into serialized lookup keys.
- Updates cumulative histogram bounds and increments monotonic counters.
- Strictly bounds memory to prevent garbage collection spikes.

### OpenTelemetry Bridge Cost (`+7.50 µs`)
The `OpenTelemetryBridge`:
- Resolves the active request span from context or `req.span`.
- Invokes span attribute setters (`smartrate.outcome`, `smartrate.remaining`, `smartrate.reset`, `smartrate.store`).
- Emits span events (`smartrate.rate_limit_exceeded`) upon 429 throttling.

---

## 5. In-Memory vs Distributed Redis Latency

When using `RedisStore`, network I/O dominates computation:

| Layer | Typical Latency | Fraction of Total |
| :--- | :---: | :---: |
| **SmartRate In-Process Execution** | 3.5 – 15 µs | ~1% |
| **Redis Network Round-Trip Time (same VPC)** | 300 – 1,000 µs | ~70% |
| **Redis Lua Script Execution** | 100 – 250 µs | ~29% |
| **Total Redis Rate Limit Check** | **0.5 – 1.3 ms** | **100%** |

**Engineering Insight:**  
Because Redis network I/O takes between 500 µs and 1,500 µs, SmartRate's 3–15 µs in-process footprint contributes **less than 1.5%** of total rate limiting time in a distributed cluster.

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
