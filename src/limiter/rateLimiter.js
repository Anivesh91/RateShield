import { MemoryStore } from '../stores/memoryStore.js';
import { buildRateLimitKey } from '../utils/keyBuilder.js';

// Default shared in-memory store for backwards compatibility when no custom store is provided
const defaultMemoryStore = new MemoryStore();

/**
 * Scans the default in-memory store and evicts expired records.
 * Exported for backwards-compatibility with v1 inspection tests.
 *
 * @returns {number} Count of removed stale records
 */
export function cleanupExpiredRecords() {
  return defaultMemoryStore.cleanupExpiredRecords();
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('SmartRate: Options must be an object.');
  }

  const { limit, windowMs, store } = options;

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
  // Strip query parameters so /endpoint?page=1 and ?page=2 share the same quota bucket
  if (req.originalUrl) {
    return req.originalUrl.split('?')[0];
  }
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

function setRateLimitHeaders(res, { limit, remaining, reset, retryAfter }) {
  if (typeof res.setHeader !== 'function') return;

  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('RateLimit-Reset', String(Math.max(0, reset)));

  if (retryAfter !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
  }
}

/**
 * SmartRate rate limiter middleware factory.
 *
 * @param {Object} options
 * @param {number} options.limit - Max requests allowed in the window
 * @param {number} options.windowMs - Window duration in milliseconds
 * @param {Object} [options.store] - Store implementation (defaults to MemoryStore)
 * @returns {import('express').RequestHandler}
 */
export function rateLimiter(options = {}) {
  validateOptions(options);

  const { limit, windowMs } = options;

  // Store lifecycle: Selected/instantiated at factory configuration time, NOT per-request
  const store = options.store || defaultMemoryStore;

  return function rateLimiterMiddleware(req, res, next) {
    const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const method = (req.method || 'GET').toUpperCase();
    const routeKey = getRouteIdentifier(req);

    const key = buildRateLimitKey({
      method,
      route: routeKey,
      clientIdentifier: clientIp
    });

    const result = store.consume({ key, limit, windowMs });

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
  };
}

export default rateLimiter;
