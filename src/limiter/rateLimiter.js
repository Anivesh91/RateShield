import { MemoryStore } from '../stores/memoryStore.js';
import { buildRateLimitKey } from '../utils/keyBuilder.js';
import { withTimeout } from '../resilience/timeoutGuard.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';

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
    successThreshold
  } = options;

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
 * @param {number} [options.timeoutMs=250] - Store operation timeout in milliseconds
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
    timeoutMs = 250,
    onStoreError,
    circuitBreaker,
    failureThreshold,
    resetTimeoutMs,
    successThreshold
  } = options;
  const algorithm = options.algorithm || 'fixed-window';
  const store = options.store || defaultMemoryStore;
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;

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

  const rateLimiterMiddleware = async function rateLimiterMiddleware(req, res, next) {
    try {
      const rawIdentifier = await keyGenerator(req);
      const clientIdentifier = (rawIdentifier !== undefined && rawIdentifier !== null && String(rawIdentifier).trim().length > 0)
        ? String(rawIdentifier).trim()
        : (req.ip || req.socket?.remoteAddress || '127.0.0.1');

      const method = (req.method || 'GET').toUpperCase();
      const routeKey = getRouteIdentifier(req);

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
      try {
        const consumeOp = () =>
          withTimeout(
            store.consume({
              key,
              limit: resolvedLimit,
              windowMs: resolvedWindowMs,
              algorithm,
              capacity: resolvedCapacity,
              refillRate: resolvedRefillRate,
              refillIntervalMs: resolvedRefillIntervalMs,
              cost: requestCost
            }),
            timeoutMs
          );

        result = breaker ? await breaker.execute(consumeOp) : await consumeOp();
      } catch (storeError) {
        if (typeof res.setHeader === 'function' && !res.headersSent) {
          res.setHeader('RateLimit-Degraded', 'true');
        }

        req.rateLimit = {
          degraded: true,
          storeError
        };

        if (onStoreError === 'fail-open') {
          return next();
        }

        if (onStoreError === 'fail-closed') {
          if (typeof res.setHeader === 'function' && !res.headersSent) {
            res.setHeader('Retry-After', '30');
          }
          return res.status(503).json({
            success: false,
            error: 'Service Unavailable',
            message: 'Rate limiting service temporarily unavailable'
          });
        }

        if (typeof onStoreError === 'function') {
          return onStoreError(storeError, req, res, next);
        }

        return next(storeError);
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
  return rateLimiterMiddleware;
}

export default rateLimiter;
