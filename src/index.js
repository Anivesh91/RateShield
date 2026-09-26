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
