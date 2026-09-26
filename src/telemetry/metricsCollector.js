import {
  METRIC_TYPE,
  METRIC_NAMES,
  CIRCUIT_STATE_GAUGE_VALUES,
  DEFAULT_STORE_DURATION_BUCKETS
} from './telemetryEvents.js';

/**
 * Produces a deterministic string key from a labels object.
 *
 * @param {Object} labels
 * @returns {string} Sorted label string
 */
function serializeLabelKey(labels = {}) {
  if (!labels || typeof labels !== 'object') return '';
  const entries = Object.entries(labels).filter(([k, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${String(v)}"`).join(',');
}

/**
 * SmartRate — Internal MetricsCollector Engine
 *
 * Lightweight, zero-external-dependency in-memory aggregator tracking
 * rate limiting throughput, outcomes, store latency, errors, and resilience states.
 *
 * Designed with a strict cardinality boundary:
 * Never stores raw URLs, user IDs, or IPs as labels.
 */
export class MetricsCollector {
  /**
   * @param {Object} [options]
   * @param {number[]} [options.storeDurationBuckets] - Custom histogram buckets in seconds
   */
  constructor(options = {}) {
    this.storeDurationBuckets = options.storeDurationBuckets || DEFAULT_STORE_DURATION_BUCKETS;

    // Internal storage: metricName -> Map(serializedLabelKey -> metricRecord)
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();

    // Default gauge for circuit breaker state (0 = CLOSED)
    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, CIRCUIT_STATE_GAUGE_VALUES.CLOSED);
  }

  /**
   * Increments a monotonic counter.
   *
   * @param {string} name - Metric name
   * @param {Object} [labels={}] - Dimension labels
   * @param {number} [value=1] - Amount to increment
   */
  incrementCounter(name, labels = {}, value = 1) {
    try {
      if (!name || typeof name !== 'string') return;
      if (typeof value !== 'number' || value <= 0) return;

      if (!this.counters.has(name)) {
        this.counters.set(name, new Map());
      }

      const metricMap = this.counters.get(name);
      const labelKey = serializeLabelKey(labels);
      const current = metricMap.get(labelKey) || { value: 0, labels: { ...labels } };

      current.value += value;
      metricMap.set(labelKey, current);
    } catch {
      // Telemetry failures must never disrupt application execution
    }
  }

  /**
   * Sets the instantaneous value of a gauge.
   *
   * @param {string} name - Metric name
   * @param {number} value - Value to set
   * @param {Object} [labels={}] - Dimension labels
   */
  setGauge(name, value, labels = {}) {
    try {
      if (!name || typeof name !== 'string') return;
      if (typeof value !== 'number' || !Number.isFinite(value)) return;

      if (!this.gauges.has(name)) {
        this.gauges.set(name, new Map());
      }

      const metricMap = this.gauges.get(name);
      const labelKey = serializeLabelKey(labels);

      metricMap.set(labelKey, {
        value,
        labels: { ...labels }
      });
    } catch {
      // Fail silent
    }
  }

  /**
   * Observes a latency observation in seconds in a cumulative histogram.
   *
   * @param {string} name - Metric name
   * @param {number} durationSeconds - Observed duration in seconds
   * @param {Object} [labels={}] - Dimension labels
   * @param {number[]} [customBuckets] - Optional custom bucket bounds
   */
  observeHistogram(name, durationSeconds, labels = {}, customBuckets = this.storeDurationBuckets) {
    try {
      if (!name || typeof name !== 'string') return;
      if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) return;

      if (!this.histograms.has(name)) {
        this.histograms.set(name, new Map());
      }

      const metricMap = this.histograms.get(name);
      const labelKey = serializeLabelKey(labels);
      let record = metricMap.get(labelKey);

      if (!record) {
        const sortedBounds = [...customBuckets].sort((a, b) => a - b);
        record = {
          labels: { ...labels },
          buckets: sortedBounds.map((le) => ({ le, count: 0 })),
          sum: 0,
          count: 0
        };
        metricMap.set(labelKey, record);
      }

      record.sum += durationSeconds;
      record.count += 1;

      // Cumulative bucket counting: increment every bucket bound >= duration
      for (const bucket of record.buckets) {
        if (durationSeconds <= bucket.le) {
          bucket.count += 1;
        }
      }
    } catch {
      // Fail silent
    }
  }

  /**
   * Convenience: Records a rate limiter request evaluation.
   *
   * @param {Object} params
   * @param {'allowed'|'blocked'} params.outcome
   * @param {string} params.algorithm
   * @param {string} params.method
   * @param {string} params.normalized_route
   * @param {string} params.store
   */
  recordRequest({ outcome, algorithm, method, normalized_route, store }) {
    this.incrementCounter(METRIC_NAMES.REQUESTS_TOTAL, {
      outcome: outcome || 'unknown',
      algorithm: algorithm || 'unknown',
      method: (method || 'GET').toUpperCase(),
      normalized_route: normalized_route || '/',
      store: store || 'unknown'
    });
  }

  /**
   * Convenience: Records a store error or timeout.
   *
   * @param {Object} params
   * @param {string} params.store
   * @param {string} params.error_type
   */
  recordStoreError({ store, error_type }) {
    this.incrementCounter(METRIC_NAMES.STORE_ERRORS_TOTAL, {
      store: store || 'unknown',
      error_type: error_type || 'store_error'
    });
  }

  /**
   * Convenience: Records a degraded fallback request.
   *
   * @param {Object} params
   * @param {string} params.reason
   */
  recordDegradedRequest({ reason }) {
    this.incrementCounter(METRIC_NAMES.DEGRADED_REQUESTS_TOTAL, {
      reason: reason || 'fallback'
    });
  }

  /**
   * Convenience: Updates the circuit breaker state gauge.
   *
   * @param {'CLOSED'|'HALF_OPEN'|'OPEN'|string} state
   */
  recordCircuitBreakerState(state) {
    const numericValue =
      CIRCUIT_STATE_GAUGE_VALUES[state] !== undefined
        ? CIRCUIT_STATE_GAUGE_VALUES[state]
        : CIRCUIT_STATE_GAUGE_VALUES.CLOSED;

    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, numericValue);
  }

  /**
   * Convenience: Records store operation duration in seconds.
   *
   * @param {number} durationSeconds - Latency in seconds
   * @param {Object} [labels={}]
   */
  recordStoreDuration(durationSeconds, labels = {}) {
    this.observeHistogram(METRIC_NAMES.STORE_DURATION_SECONDS, durationSeconds, labels);
  }

  /**
   * Returns a structured snapshot of all recorded metrics.
   *
   * @returns {Object} Metric data snapshot
   */
  getSnapshot() {
    const snapshot = {
      counters: {},
      gauges: {},
      histograms: {}
    };

    for (const [name, metricMap] of this.counters.entries()) {
      snapshot.counters[name] = [];
      for (const record of metricMap.values()) {
        snapshot.counters[name].push({ ...record, labels: { ...record.labels } });
      }
    }

    for (const [name, metricMap] of this.gauges.entries()) {
      snapshot.gauges[name] = [];
      for (const record of metricMap.values()) {
        snapshot.gauges[name].push({ ...record, labels: { ...record.labels } });
      }
    }

    for (const [name, metricMap] of this.histograms.entries()) {
      snapshot.histograms[name] = [];
      for (const record of metricMap.values()) {
        snapshot.histograms[name].push({
          labels: { ...record.labels },
          buckets: record.buckets.map((b) => ({ ...b })),
          sum: record.sum,
          count: record.count
        });
      }
    }

    return snapshot;
  }

  /**
   * Resets all internal metric values.
   */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, CIRCUIT_STATE_GAUGE_VALUES.CLOSED);
  }
}

// Default singleton collector instance
export const defaultMetricsCollector = new MetricsCollector();
