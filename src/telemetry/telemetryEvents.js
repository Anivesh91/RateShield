/**
 * SmartRate — Telemetry Event Constants & Enums
 *
 * Defines standardized metric names, types, gauge state mappings,
 * and default latency histogram bucket thresholds.
 */

export const METRIC_TYPE = Object.freeze({
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram'
});

export const METRIC_NAMES = Object.freeze({
  REQUESTS_TOTAL: 'smartrate_requests_total',
  STORE_ERRORS_TOTAL: 'smartrate_store_errors_total',
  DEGRADED_REQUESTS_TOTAL: 'smartrate_degraded_requests_total',
  CIRCUIT_BREAKER_STATE: 'smartrate_circuit_breaker_state',
  STORE_DURATION_SECONDS: 'smartrate_store_duration_seconds'
});

export const CIRCUIT_STATE_GAUGE_VALUES = Object.freeze({
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2
});

/**
 * Targeted histogram buckets for rate limiter store operations in seconds:
 * Ranges from 0.5ms (0.0005s) up to 1.0s, matching typical in-memory and Redis I/O.
 */
export const DEFAULT_STORE_DURATION_BUCKETS = Object.freeze([
  0.0005,
  0.001,
  0.0025,
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1.0
]);
