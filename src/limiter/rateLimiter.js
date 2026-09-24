import { MemoryStore } from '../stores/memoryStore.js';
import { buildRateLimitKey } from '../utils/keyBuilder.js';

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

const SUPPORTED_ALGORITHMS = Object.freeze(['fixed-window', 'sliding-window']);

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('SmartRate: Options must be an object.');
  }

  const { limit, windowMs, store, algorithm = 'fixed-window', keyGenerator } = options;

  if (keyGenerator !== undefined && typeof keyGenerator !== 'function') {
    throw new TypeError("SmartRate: 'keyGenerator' must be a function.");
  }

  if (typeof algorithm !== 'string' || !SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new TypeError(
      `SmartRate: Unsupported algorithm '${algorithm}'. Supported algorithms: ${SUPPORTED_ALGORITHMS.join(', ')}.`
    );
  }

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`SmartRate: 'limit' must be a positive integer (received: ${limit}).`);
  }

  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`SmartRate: 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`);
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
 * @param {number} options.limit - Max requests allowed in the window
 * @param {number} options.windowMs - Window duration in milliseconds
 * @param {'fixed-window'|'sliding-window'} [options.algorithm='fixed-window'] - Rate limiting algorithm
 * @param {Object} [options.store] - Store implementation (defaults to MemoryStore)
 * @returns {import('express').RequestHandler}
 */
export function rateLimiter(options = {}) {
  validateOptions(options);

  const { limit, windowMs } = options;
  const algorithm = options.algorithm || 'fixed-window';
  const store = options.store || defaultMemoryStore;
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;

  return async function rateLimiterMiddleware(req, res, next) {
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

      const result = await store.consume({ key, limit, windowMs, algorithm });

      setRateLimitHeaders(res, {
        limit,
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
}

export default rateLimiter;
