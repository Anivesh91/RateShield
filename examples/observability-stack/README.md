# SmartRate V7 — Production Observability Demo Stack

A complete, production-grade observability demo showcasing **SmartRate V7** running with **Prometheus**, **Grafana**, **OpenTelemetry**, **Distributed Redis**, and **Dual-Store Fallback Resilience**.

---

## Architecture Overview

```
                      +-----------------------------+
                      |       Client Traffic        |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |      Express Application    |
                      |   (SmartRate V7 Middleware) |
                      +--------------+--------------+
                                     |
                +--------------------+--------------------+
                |                                         |
     (Primary Distributed)                          (Local Fallback)
                v                                         v
       +-----------------+                       +-----------------+
       |   RedisStore    |                       |   MemoryStore   |
       +--------+--------+                       +-----------------+
                |
                v (On Failure / Timeout / Circuit Trip)
       +-----------------+
       | Circuit Breaker | -> Degraded Mode: Serves from MemoryStore
       +-----------------+
                |
                v
       +-----------------+
       |    /metrics     | <--- Scraped by Prometheus (:9090)
       +-----------------+             |
                                       v
                              +-----------------+
                              |     Grafana     | (:3001)
                              |    Dashboard    |
                              +-----------------+
```

---

## Quickstart (Docker Compose)

### 1. Launch the Stack
From the project root directory:
```bash
docker-compose -f examples/observability-stack/docker-compose.yml up -d --build
```

### 2. Verify Services
- **SmartRate Express App**: [http://localhost:3000](http://localhost:3000)
- **Prometheus Metrics**: [http://localhost:3000/metrics](http://localhost:3000/metrics)
- **Prometheus UI & Alerts**: [http://localhost:9090](http://localhost:9090)
- **Grafana Dashboard**: [http://localhost:3001](http://localhost:3001) *(login: `admin` / `admin`)*

### 3. Run the Traffic Simulator
In a separate terminal, trigger realistic production traffic, bursts, rate limits, chaos outages, and recovery:
```bash
node examples/observability-stack/simulate-traffic.js
```

---

## Running Locally Without Docker

You can also run the demo directly on your host machine without Docker:

### 1. Start the Demo Server
```bash
node examples/observability-stack/server.js
```

### 2. Generate Traffic
In another terminal:
```bash
node examples/observability-stack/simulate-traffic.js
```

### 3. Inspect Live Metrics
```bash
curl http://localhost:3000/metrics
```

---

## Live Chaos & Resilience Demonstration

The demo server includes built-in chaos endpoints to simulate storage disasters and witness automatic fallback and alert triggers:

### Break Redis (Trigger Outage & Circuit Trip):
```bash
curl -X POST http://localhost:3000/api/chaos/break-store
```
- SmartRate immediately transitions to local `MemoryStore` fallback.
- Adds `RateLimit-Degraded: true` header to responses.
- Increments `smartrate_store_errors_total{store="redis"}`.
- Trips Circuit Breaker to `OPEN` (value `2` on `smartrate_circuit_breaker_state`).
- Fires `SmartRateStoreOutage` and `SmartRateCircuitBreakerOpen` Prometheus alerts.

### Heal Redis (Trigger Recovery & Canary Probe):
```bash
curl -X POST http://localhost:3000/api/chaos/heal-store
```
- Restores primary Redis store.
- After `resetTimeoutMs` (10s), Circuit Breaker lazily moves to `HALF_OPEN`.
- Next request acts as a canary probe, validating Redis health.
- Circuit transitions back to `CLOSED` (value `0`), recovering seamlessly!

---

## Observability Assets Included

- **Alert Rules**: [`assets/alerts/prometheus-rules.yml`](../../assets/alerts/prometheus-rules.yml)
  - `SmartRateHighBlockRate` (High 429 block rate)
  - `SmartRateStoreOutage` (Store errors/timeouts)
  - `SmartRateCircuitBreakerOpen` (Circuit trip)
  - `SmartRateElevatedStoreLatency` (p95 store latency > 50ms)
  - `SmartRateHighDegradedTraffic` (Degraded fallback requests)
- **Grafana Dashboard**: [`assets/dashboards/smartrate-grafana-dashboard.json`](../../assets/dashboards/smartrate-grafana-dashboard.json)
  - Throughput (allowed vs blocked)
  - Block Rate percentage
  - Circuit Breaker State gauge
  - p95/p99 Store Operation Latency
  - Store Errors & Fallback Traffic
  - Route Breakdown
