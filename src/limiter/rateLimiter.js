/**
 * SmartRate — In-Memory Fixed Window Rate Limiting Middleware
 */

/**
 * Shared in-memory Map storing active Fixed Window state.
 * KEY:   "${clientIp}:${routePath}"
 * VALUE: { count: number, windowStart: number, windowMs: number }
 */
const store = new Map();

/**
 * Singleton timer reference for the background memory cleanup.
 */
let cleanupInterval = null;

/**
 * Default interval in milliseconds for running the memory cleanup sweeper (60 seconds).
 */
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Expired State / Stale Entry Cleanup:
 * Scans the in-memory Map and deletes records whose Fixed Windows
 * have elapsed. This prevents expired rate-limit entries from accumulating
 * indefinitely over long-running server processes.
 *
 * NOTE: This does not guarantee strictly bounded memory under massive concurrent
 * unique IP floods within an active window, but ensures expired records are evicted.
 */
export function cleanupExpiredRecords() {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    if (now - record.windowStart >= record.windowMs) {
      store.delete(key);
    }
  }
}

/**
 * Ensures a single background interval is active to periodically sweep
 * expired entries from memory. Uses timer.unref() so it does not block process exit.
 *
 * @param {number} [intervalMs=60000]
 */
function ensureCleanupTimer(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS) {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      cleanupExpiredRecords();
    }, intervalMs);

    // unref() tells Node.js event loop not to wait for this timer to exit the process
    if (typeof cleanupInterval.unref === 'function') {
      cleanupInterval.unref();
    }
  }
}

/**
 * Validates configuration options passed to the rateLimiter factory.
 *
 * @param {Object} options
 * @param {number} options.limit - Maximum number of allowed requests per window.
 * @param {number} options.windowMs - Time window duration in milliseconds.
 * @throws {TypeError|RangeError} If options are invalid.
 */
function validateOptions(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('SmartRate: Options must be an object.');
  }

  const { limit, windowMs } = options;

  // Validate limit: Must be a positive integer
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(
      `SmartRate: 'limit' must be a positive integer (received: ${limit}).`
    );
  }

  // Validate windowMs: Must be a positive finite number
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(
      `SmartRate: 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`
    );
  }
}

/**
 * Resolves a stable route identifier from the request object,
 * stripping query parameters.
 *
 * @param {import('express').Request} req
 * @returns {string} Clean route path (e.g. "/api/login")
 */
function getRouteIdentifier(req) {
  if (req.originalUrl) {
    return req.originalUrl.split('?')[0];
  }
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

/**
 * Middleware factory that creates a rate limiter middleware.
 *
 * @param {Object} options
 * @param {number} options.limit - Maximum requests allowed in the window.
 * @param {number} options.windowMs - Window size in milliseconds.
 * @returns {import('express').RequestHandler}
 */
export function rateLimiter(options = {}) {
  // Validate configuration at factory creation time (Fail-Fast)
  validateOptions(options);

  const { limit, windowMs } = options;

  // Ensure the shared background cleanup timer is active
  ensureCleanupTimer();

  return function rateLimiterMiddleware(req, res, next) {
    const now = Date.now();
    const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const routeKey = getRouteIdentifier(req);
    const key = `${clientIp}:${routeKey}`;

    const record = store.get(key);

    // CASE 1: No record exists for this client + route -> Initialize
    if (!record) {
      store.set(key, {
        count: 1,
        windowStart: now,
        windowMs
      });
      return next();
    }

    const elapsedTime = now - record.windowStart;

    // CASE 2: Active window has expired -> Reset counter and windowStart
    if (elapsedTime >= windowMs) {
      record.count = 1;
      record.windowStart = now;
      record.windowMs = windowMs;
      return next();
    }

    // CASE 3: Window is still active and quota is available -> Increment
    if (record.count < limit) {
      record.count += 1;
      return next();
    }

    // CASE 4: Rate limit reached or exceeded -> HTTP 429 Too Many Requests
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((record.windowStart + windowMs - now) / 1000)
    );

    return res.status(429).json({
      success: false,
      message: 'Too many requests',
      retryAfter: retryAfterSeconds
    });
  };
}

export default rateLimiter;
