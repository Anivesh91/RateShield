import { MemoryStore } from '../stores/memoryStore.js';
import { RedisStore } from '../stores/redisStore.js';
import { ResilientStore } from '../stores/resilientStore.js';
import { buildRateLimitKey } from '../utils/keyBuilder.js';
import { withTimeout } from '../resilience/timeoutGuard.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { CircuitBreakerOpenError, StoreTimeoutError } from '../resilience/errors.js';
import { normalizeRoute } from '../utils/routeNormalizer.js';
import { MetricsCollector, defaultMetricsCollector } from '../telemetry/metricsCollector.js';
import { OpenTelemetryBridge } from '../telemetry/openTelemetryBridge.js';

const defaultMemoryStore = new MemoryStore();

/**
 * Scans the default in-memory store and evicts expired records.
 * Exported for backwards compatibility with test assertions.
 *
 * @returns {number}
 */
export function cleanupExpiredRecords() {
  return defaultMemoryStore.cleanupExpiredRecords();
}

const defaultKeyGenerator = (req) => req.ip || req.socket?.remoteAddress || '127.0.0.1';

const SUPPORTED_ALGORITHMS = Object.freeze(['fixed-window', 'sliding-window', 'token-bucket']);

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('SmartRate: Options must be an object.');
  }

  const {
    limit,
    windowMs,
    store,
    algorithm = 'fixed-window',
    keyGenerator,
    capacity,
    refillRate,
    refillIntervalMs,
    cost,
    timeoutMs,
    onStoreError,
    circuitBreaker,
    failureThreshold,
    resetTimeoutMs,
    successThreshold,
    fallbackStore,
    metrics,
    metricsCollector,
    routeNormalizer,
    openTelemetry
  } = options;

  if (openTelemetry !== undefined) {
    if (
      typeof openTelemetry !== 'boolean' &&
      (typeof openTelemetry !== 'object' || openTelemetry === null)
    ) {
      throw new TypeError("SmartRate: 'openTelemetry' must be a boolean, an options object, or an OpenTelemetryBridge instance.");
    }
  }

  if (metrics !== undefined && typeof metrics !== 'boolean') {
    throw new TypeError("SmartRate: 'metrics' must be a boolean.");
  }

  if (metricsCollector !== undefined && (typeof metricsCollector !== 'object' || metricsCollector === null || typeof metricsCollector.recordRequest !== 'function')) {
    throw new TypeError("SmartRate: 'metricsCollector' must be an object implementing a recordRequest() method.");
  }

  if (routeNormalizer !== undefined && typeof routeNormalizer !== 'function') {
    throw new TypeError("SmartRate: 'routeNormalizer' must be a function.");
  }

  if (fallbackStore !== undefined) {
    if (typeof fallbackStore !== 'boolean' && (typeof fallbackStore !== 'object' || fallbackStore === null || typeof fallbackStore.consume !== 'function')) {
      throw new TypeError("SmartRate: 'fallbackStore' must be a boolean or an object implementing a consume() method.");
    }
  }

  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError(`SmartRate: 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`);
  }

  const VALID_STORE_ERROR_MODES = ['fail-open', 'fail-closed', 'error'];
  if (
    onStoreError !== undefined &&
    typeof onStoreError !== 'function' &&
    !VALID_STORE_ERROR_MODES.includes(onStoreError)
  ) {
    throw new TypeError(
      `SmartRate: 'onStoreError' must be 'fail-open', 'fail-closed', 'error', or a function (received: ${onStoreError}).`
    );
  }

  if (circuitBreaker !== undefined) {
    if (typeof circuitBreaker !== 'boolean' && (typeof circuitBreaker !== 'object' || circuitBreaker === null)) {
      throw new TypeError("SmartRate: 'circuitBreaker' must be a boolean, an options object, or a CircuitBreaker instance.");
    }
    if (typeof circuitBreaker === 'object' && !(circuitBreaker instanceof CircuitBreaker)) {
      const cbFailureThreshold = circuitBreaker.failureThreshold;
      const cbResetTimeoutMs = circuitBreaker.resetTimeoutMs;
      const cbSuccessThreshold = circuitBreaker.successThreshold;

      if (cbFailureThreshold !== undefined && (typeof cbFailureThreshold !== 'number' || !Number.isInteger(cbFailureThreshold) || cbFailureThreshold <= 0)) {
        throw new RangeError(`SmartRate: CircuitBreaker 'failureThreshold' must be a positive integer (received: ${cbFailureThreshold}).`);
      }
      if (cbResetTimeoutMs !== undefined && (typeof cbResetTimeoutMs !== 'number' || !Number.isFinite(cbResetTimeoutMs) || cbResetTimeoutMs <= 0)) {
        throw new RangeError(`SmartRate: CircuitBreaker 'resetTimeoutMs' must be a positive number in milliseconds (received: ${cbResetTimeoutMs}).`);
      }
      if (cbSuccessThreshold !== undefined && (typeof cbSuccessThreshold !== 'number' || !Number.isInteger(cbSuccessThreshold) || cbSuccessThreshold <= 0)) {
        throw new RangeError(`SmartRate: CircuitBreaker 'successThreshold' must be a positive integer (received: ${cbSuccessThreshold}).`);
      }
    }
  }

  if (failureThreshold !== undefined && (typeof failureThreshold !== 'number' || !Number.isInteger(failureThreshold) || failureThreshold <= 0)) {
    throw new RangeError(`SmartRate: CircuitBreaker 'failureThreshold' must be a positive integer (received: ${failureThreshold}).`);
  }
  if (resetTimeoutMs !== undefined && (typeof resetTimeoutMs !== 'number' || !Number.isFinite(resetTimeoutMs) || resetTimeoutMs <= 0)) {
    throw new RangeError(`SmartRate: CircuitBreaker 'resetTimeoutMs' must be a positive number in milliseconds (received: ${resetTimeoutMs}).`);
  }
  if (successThreshold !== undefined && (typeof successThreshold !== 'number' || !Number.isInteger(successThreshold) || successThreshold <= 0)) {
    throw new RangeError(`SmartRate: CircuitBreaker 'successThreshold' must be a positive integer (received: ${successThreshold}).`);
  }

  if (keyGenerator !== undefined && typeof keyGenerator !== 'function') {
    throw new TypeError("SmartRate: 'keyGenerator' must be a function.");
  }

  if (typeof algorithm !== 'string' || !SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new TypeError(
      `SmartRate: Unsupported algorithm '${algorithm}'. Supported algorithms: ${SUPPORTED_ALGORITHMS.join(', ')}.`
    );
  }

  if (algorithm === 'token-bucket') {
    const hasCapacity = capacity !== undefined || limit !== undefined;
    if (!hasCapacity) {
      throw new RangeError(
        "SmartRate: Token Bucket requires a positive integer 'capacity' (or 'limit') (received: undefined)."
      );
    }

    if (capacity !== undefined) {
      if (typeof capacity !== 'function' && (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0)) {
        throw new RangeError(
          `SmartRate: Token Bucket requires a positive integer 'capacity' (or 'limit') (received: ${capacity}).`
        );
      }
    } else if (limit !== undefined) {
      if (typeof limit !== 'function' && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
        throw new RangeError(
          `SmartRate: Token Bucket requires a positive integer 'capacity' (or 'limit') (received: ${limit}).`
        );
      }
    }

    const hasRefill = refillRate !== undefined || (limit !== undefined && windowMs !== undefined);
    if (!hasRefill) {
      throw new RangeError(
        "SmartRate: Token Bucket requires a positive number 'refillRate' (or 'limit' and 'windowMs') (received: undefined)."
      );
    }

    if (refillRate !== undefined) {
      if (typeof refillRate !== 'function' && (typeof refillRate !== 'number' || !Number.isFinite(refillRate) || refillRate <= 0)) {
        throw new RangeError(
          `SmartRate: Token Bucket requires a positive number 'refillRate' (or 'limit' and 'windowMs') (received: ${refillRate}).`
        );
      }
    }

    if (refillIntervalMs !== undefined) {
      if (typeof refillIntervalMs !== 'function' && (typeof refillIntervalMs !== 'number' || !Number.isFinite(refillIntervalMs) || refillIntervalMs <= 0)) {
        throw new RangeError(
          `SmartRate: Token Bucket requires a positive number 'refillIntervalMs' (received: ${refillIntervalMs}).`
        );
      }
    }

    if (cost !== undefined) {
      if (typeof cost !== 'number' && typeof cost !== 'function') {
        throw new TypeError("SmartRate: 'cost' must be a positive integer or a function.");
      }
      if (typeof cost === 'number' && (!Number.isInteger(cost) || cost <= 0)) {
        throw new RangeError(`SmartRate: 'cost' must be a positive integer (received: ${cost}).`);
      }
    }
  } else {
    if (typeof limit !== 'function' && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
      throw new RangeError(`SmartRate: 'limit' must be a positive integer (received: ${limit}).`);
    }

    if (typeof windowMs !== 'function' && (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0)) {
      throw new RangeError(`SmartRate: 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`);
    }
  }

  if (store !== undefined && (!store || typeof store.consume !== 'function')) {
    throw new TypeError("SmartRate: 'store' must be an object implementing a consume() method.");
  }
}

function getRouteIdentifier(req) {
  if (req.originalUrl) {
    return req.originalUrl.split('?')[0];
  }
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

function setRateLimitHeaders(res, { limit, remaining, reset, retryAfter }) {
  if (typeof res.setHeader !== 'function' || res.headersSent) return;

  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('RateLimit-Reset', String(Math.max(1, reset)));

  if (retryAfter !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  }
}

/**
 * SmartRate rate limiter middleware factory.
 *
 * @param {Object} options
 * @param {number|Function} [options.limit] - Max requests allowed in the window (or dynamic policy function)
 * @param {number|Function} [options.windowMs] - Window duration in milliseconds (or dynamic function)
 * @param {'fixed-window'|'sliding-window'|'token-bucket'} [options.algorithm='fixed-window'] - Selected algorithm
 * @param {number|Function} [options.capacity] - Token bucket capacity (or dynamic function)
 * @param {number|Function} [options.refillRate] - Token bucket refill rate (or dynamic function)
 * @param {number|Function} [options.refillIntervalMs=1000] - Refill interval duration in milliseconds (or dynamic function)
 * @param {number|Function} [options.cost=1] - Request cost in tokens (or dynamic function)
 * @param {number} [options.timeoutMs] - Optional store operation timeout in milliseconds
 * @param {'fail-open'|'fail-closed'|'error'|Function} [options.onStoreError] - Policy when store errors or times out
 * @param {boolean|Object|CircuitBreaker} [options.circuitBreaker] - Circuit breaker configuration or instance
 * @param {number} [options.failureThreshold=5] - Consecutive failures before opening circuit
 * @param {number} [options.resetTimeoutMs=10000] - Duration in ms before testing recovery in HALF_OPEN
 * @param {number} [options.successThreshold=1] - Consecutive successful probes in HALF_OPEN to close circuit
 * @param {Function} [options.keyGenerator] - Custom client identifier extractor
 * @param {Object} [options.store] - Store implementation (defaults to MemoryStore)
 * @returns {import('express').RequestHandler}
 */
export function rateLimiter(options = {}) {
  validateOptions(options);

  const {
    limit,
    windowMs,
    capacity,
    refillRate,
    refillIntervalMs = 1000,
    cost = 1,
    timeoutMs,
    onStoreError,
    circuitBreaker,
    failureThreshold,
    resetTimeoutMs,
    successThreshold,
    fallbackStore,
    metrics,
    metricsCollector,
    routeNormalizer,
    openTelemetry
  } = options;
  const algorithm = options.algorithm || 'fixed-window';
  let store = options.store || defaultMemoryStore;
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;

  const collector = metricsCollector || (metrics ? defaultMetricsCollector : null);

  let otelBridge = null;
  if (openTelemetry instanceof OpenTelemetryBridge) {
    otelBridge = openTelemetry;
  } else if (typeof openTelemetry === 'object' && openTelemetry !== null) {
    otelBridge = typeof openTelemetry.recordEvaluation === 'function' ? openTelemetry : new OpenTelemetryBridge(openTelemetry);
  } else if (openTelemetry === true) {
    otelBridge = new OpenTelemetryBridge();
  }

  let breaker = null;
  if (circuitBreaker instanceof CircuitBreaker) {
    breaker = circuitBreaker;
  } else if (typeof circuitBreaker === 'object' && circuitBreaker !== null) {
    breaker = new CircuitBreaker(circuitBreaker);
  } else if (circuitBreaker === true) {
    breaker = new CircuitBreaker({ failureThreshold, resetTimeoutMs, successThreshold });
  } else if (failureThreshold !== undefined || resetTimeoutMs !== undefined || successThreshold !== undefined) {
    breaker = new CircuitBreaker({ failureThreshold, resetTimeoutMs, successThreshold });
  }

  if (store instanceof ResilientStore) {
    const hasBreakerOptions =
      circuitBreaker !== undefined ||
      failureThreshold !== undefined ||
      resetTimeoutMs !== undefined ||
      successThreshold !== undefined;
    if (hasBreakerOptions && breaker !== store.circuitBreaker) {
      throw new TypeError("SmartRate: Configure the circuit breaker on the ResilientStore when using it as the store.");
    }
    breaker = store.circuitBreaker;
  } else if (fallbackStore) {
    store = new ResilientStore({
      primaryStore: store,
      fallbackStore: fallbackStore === true ? undefined : fallbackStore,
      circuitBreaker: circuitBreaker === false ? false : (breaker || undefined),
      timeoutMs
    });
    breaker = store.circuitBreaker;
  }

  if (collector && breaker) {
    const recordCircuitBreakerState = (state) => {
      try {
        if (typeof collector.recordCircuitBreakerState === 'function') {
          collector.recordCircuitBreakerState(state);
        }
      } catch {
        // Safe telemetry
      }
    };
    breaker.on('stateChange', (evt) => recordCircuitBreakerState(evt.to));
    try {
      recordCircuitBreakerState(breaker.getState());
    } catch {
      // Safe telemetry
    }
  }

  const isResilient = store instanceof ResilientStore;

  const safeTelemetry = (fn) => {
    try {
      fn();
    } catch {
      // Telemetry failure must never disrupt request processing
    }
  };

  const rateLimiterMiddleware = async function rateLimiterMiddleware(req, res, next) {
    try {
      const rawIdentifier = await keyGenerator(req);
      const clientIdentifier = (rawIdentifier !== undefined && rawIdentifier !== null && String(rawIdentifier).trim().length > 0)
        ? String(rawIdentifier).trim()
        : (req.ip || req.socket?.remoteAddress || '127.0.0.1');

      const method = (req.method || 'GET').toUpperCase();
      const routeKey = getRouteIdentifier(req);
      const normalizedRoute = (collector || otelBridge) ? normalizeRoute(req, routeNormalizer) : '/';
      const defaultStoreLabel = isResilient
        ? 'resilient'
        : (store instanceof RedisStore ? 'redis' : (store instanceof MemoryStore ? 'memory' : 'custom'));

      const key = buildRateLimitKey({
        algorithm,
        method,
        route: routeKey,
        clientIdentifier
      });

      // 1. Resolve dynamic limit & windowMs
      const resolvedLimit = typeof limit === 'function' ? await limit(req) : limit;
      const resolvedWindowMs = typeof windowMs === 'function' ? await windowMs(req) : windowMs;

      // 2. Resolve dynamic capacity & refillRate
      const resolvedCapacity = typeof capacity === 'function'
        ? await capacity(req)
        : (capacity ?? resolvedLimit);

      const resolvedRefillIntervalMs = typeof refillIntervalMs === 'function'
        ? await refillIntervalMs(req)
        : (refillIntervalMs ?? 1000);

      let resolvedRefillRate;
      if (typeof refillRate === 'function') {
        resolvedRefillRate = await refillRate(req);
      } else if (refillRate !== undefined) {
        resolvedRefillRate = refillRate;
      } else if (resolvedLimit && resolvedWindowMs) {
        resolvedRefillRate = resolvedLimit * (resolvedRefillIntervalMs / resolvedWindowMs);
      }

      // 3. Resolve dynamic request cost
      let requestCost = 1;
      if (typeof cost === 'function') {
        requestCost = await cost(req);
      } else if (typeof cost === 'number') {
        requestCost = cost;
      }

      // 4. Validate resolved dynamic values fail-fast
      if (algorithm === 'token-bucket') {
        if (typeof resolvedCapacity !== 'number' || !Number.isInteger(resolvedCapacity) || resolvedCapacity <= 0) {
          throw new RangeError(`SmartRate: Dynamic 'capacity' must resolve to a positive integer (received: ${resolvedCapacity}).`);
        }
        if (typeof resolvedRefillRate !== 'number' || !Number.isFinite(resolvedRefillRate) || resolvedRefillRate <= 0) {
          throw new RangeError(`SmartRate: Dynamic 'refillRate' must resolve to a positive number (received: ${resolvedRefillRate}).`);
        }
        if (typeof resolvedRefillIntervalMs !== 'number' || !Number.isFinite(resolvedRefillIntervalMs) || resolvedRefillIntervalMs <= 0) {
          throw new RangeError(`SmartRate: Dynamic 'refillIntervalMs' must resolve to a positive number (received: ${resolvedRefillIntervalMs}).`);
        }
        if (typeof requestCost !== 'number' || !Number.isInteger(requestCost) || requestCost <= 0) {
          throw new RangeError(`SmartRate: Dynamic 'cost' must resolve to a positive integer (received: ${requestCost}).`);
        }
      } else {
        if (typeof resolvedLimit !== 'number' || !Number.isInteger(resolvedLimit) || resolvedLimit <= 0) {
          throw new RangeError(`SmartRate: Dynamic 'limit' must resolve to a positive integer (received: ${resolvedLimit}).`);
        }
        if (typeof resolvedWindowMs !== 'number' || !Number.isFinite(resolvedWindowMs) || resolvedWindowMs <= 0) {
          throw new RangeError(`SmartRate: Dynamic 'windowMs' must resolve to a positive number in milliseconds (received: ${resolvedWindowMs}).`);
        }
      }

      let result;
      let storeStart = 0;
      if (collector) {
        storeStart = process.hrtime.bigint();
      }

      try {
        const consumeOp = () => {
          const storeOperation = store.consume({
            key,
            limit: resolvedLimit,
            windowMs: resolvedWindowMs,
            algorithm,
            capacity: resolvedCapacity,
            refillRate: resolvedRefillRate,
            refillIntervalMs: resolvedRefillIntervalMs,
            cost: requestCost
          });
          return (timeoutMs === undefined || isResilient) ? storeOperation : withTimeout(storeOperation, timeoutMs);
        };

        result = (breaker && !isResilient) ? await breaker.execute(consumeOp) : await consumeOp();

        if (collector && storeStart > 0) {
          const durationSec = Number(process.hrtime.bigint() - storeStart) / 1e9;
          const activeStore = result.store || (result.fallbackUsed ? 'fallback' : defaultStoreLabel);
          safeTelemetry(() => collector.recordStoreDuration(durationSec, { store: activeStore }));
        }
      } catch (storeError) {
        if (collector && storeStart > 0) {
          const durationSec = Number(process.hrtime.bigint() - storeStart) / 1e9;
          safeTelemetry(() => collector.recordStoreDuration(durationSec, { store: defaultStoreLabel }));
        }

        if (typeof res.setHeader === 'function' && !res.headersSent) {
          res.setHeader('RateLimit-Degraded', 'true');
        }

        req.rateLimit = {
          degraded: true,
          storeError
        };

        if (collector) {
          safeTelemetry(() => {
            const errorType =
              storeError instanceof StoreTimeoutError
                ? 'timeout'
                : storeError instanceof CircuitBreakerOpenError
                  ? 'circuit_open'
                  : (storeError?.code === 'ECONNREFUSED' ? 'econnrefused' : 'store_error');

            collector.recordStoreError({ store: defaultStoreLabel, error_type: errorType });
            collector.recordDegradedRequest({ reason: errorType });

            if (onStoreError === 'fail-open') {
              collector.recordRequest({
                outcome: 'allowed',
                algorithm,
                method,
                normalized_route: normalizedRoute,
                store: defaultStoreLabel
              });
            } else if (onStoreError === 'fail-closed') {
              collector.recordRequest({
                outcome: 'blocked',
                algorithm,
                method,
                normalized_route: normalizedRoute,
                store: defaultStoreLabel
              });
            }
          });
        }

        if (otelBridge) {
          safeTelemetry(() => {
            otelBridge.recordStoreError({ req, storeError, store: defaultStoreLabel });
            if (onStoreError === 'fail-open' || onStoreError === 'fail-closed') {
              otelBridge.recordEvaluation({
                req,
                result: {
                  allowed: onStoreError === 'fail-open',
                  remaining: 0,
                  reset: 30,
                  retryAfter: 30
                },
                algorithm,
                normalizedRoute,
                store: defaultStoreLabel
              });
            }
          });
        }

        if (onStoreError === 'fail-open') {
          return next();
        }

        if (onStoreError === 'fail-closed') {
          let retryAfterSeconds = 30;

          if (storeError instanceof CircuitBreakerOpenError && typeof storeError.resetTimeoutMs === 'number') {
            retryAfterSeconds = Math.max(1, Math.ceil(storeError.resetTimeoutMs / 1000));
          } else if (breaker && breaker.isOpen()) {
            const remainingMs = Math.max(0, breaker.nextAttempt - Date.now());
            retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
          }

          if (typeof res.setHeader === 'function' && !res.headersSent) {
            res.setHeader('Retry-After', String(retryAfterSeconds));
          }
          return res.status(503).json({
            success: false,
            error: 'Service Unavailable',
            message: 'Rate limiting service temporarily unavailable'
          });
        }

        if (typeof onStoreError === 'function') {
          return await onStoreError(storeError, req, res, next);
        }

        return next(storeError);
      }

      if (result.degraded) {
        if (typeof res.setHeader === 'function' && !res.headersSent) {
          res.setHeader('RateLimit-Degraded', 'true');
        }

        const primaryErrorName = typeof result.primaryError?.name === 'string' && result.primaryError.name
          ? result.primaryError.name
          : 'Error';

        req.rateLimit = {
          degraded: true,
          fallbackUsed: Boolean(result.fallbackUsed),
          store: result.store,
          primaryError: primaryErrorName
        };
      }

      if (collector) {
        safeTelemetry(() => {
          if (result.degraded) {
            collector.recordDegradedRequest({
              reason: result.primaryError?.name || 'fallback'
            });
          }
          const activeStore = result.store || (result.fallbackUsed ? 'fallback' : defaultStoreLabel);
          collector.recordRequest({
            outcome: result.allowed ? 'allowed' : 'blocked',
            algorithm,
            method,
            normalized_route: normalizedRoute,
            store: activeStore
          });
        });
      }

      if (otelBridge) {
        safeTelemetry(() => {
          const activeStore = result.store || (result.fallbackUsed ? 'fallback' : defaultStoreLabel);
          otelBridge.recordEvaluation({
            req,
            result,
            algorithm,
            normalizedRoute,
            store: activeStore
          });
        });
      }

      const headerLimit = algorithm === 'token-bucket' ? resolvedCapacity : resolvedLimit;

      setRateLimitHeaders(res, {
        limit: headerLimit,
        remaining: result.remaining,
        reset: result.reset,
        retryAfter: result.retryAfter
      });

      if (result.allowed) {
        return next();
      }

      return res.status(429).json({
        success: false,
        message: 'Too many requests',
        retryAfter: result.retryAfter
      });
    } catch (err) {
      return next(err);
    }
  };

  rateLimiterMiddleware.circuitBreaker = breaker;
  rateLimiterMiddleware.metricsCollector = collector;
  return rateLimiterMiddleware;
}

export default rateLimiter;
