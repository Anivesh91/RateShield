/**
 * SmartRate — Public Package Entry Point
 *
 * Facade pattern: Exposes consumer-facing APIs (middleware, stores, keyBuilder).
 */
export { default, rateLimiter } from './limiter/rateLimiter.js';
export { MemoryStore } from './stores/memoryStore.js';
export { RedisStore } from './stores/redisStore.js';
export { ResilientStore } from './stores/resilientStore.js';
export { buildRateLimitKey } from './utils/keyBuilder.js';
export { StoreTimeoutError, CircuitBreakerOpenError } from './resilience/errors.js';
export { withTimeout } from './resilience/timeoutGuard.js';
export { CircuitBreaker, CIRCUIT_STATE } from './resilience/circuitBreaker.js';
export { MetricsCollector, defaultMetricsCollector } from './telemetry/metricsCollector.js';
export {
  METRIC_NAMES,
  METRIC_TYPE,
  METRIC_METADATA,
  CIRCUIT_STATE_GAUGE_VALUES,
  DEFAULT_STORE_DURATION_BUCKETS
} from './telemetry/telemetryEvents.js';
export { normalizeRoute, sanitizePath } from './utils/routeNormalizer.js';
export {
  createPrometheusExporter,
  formatPrometheusMetrics,
  escapeLabelValue,
  escapeHelpString,
  formatLabels
} from './telemetry/prometheusExporter.js';
