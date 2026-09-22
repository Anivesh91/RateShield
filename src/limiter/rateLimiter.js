const store = new Map();
let cleanupInterval = null;

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export function cleanupExpiredRecords() {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    if (now - record.windowStart >= record.windowMs) {
      store.delete(key);
    }
  }
}

function ensureCleanupTimer(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS) {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupExpiredRecords, intervalMs);

    // unref() ensures this background timer does not hold the Node.js event loop open
    // during graceful shutdowns or test runs
    if (typeof cleanupInterval.unref === 'function') {
      cleanupInterval.unref();
    }
  }
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('SmartRate: Options must be an object.');
  }

  const { limit, windowMs } = options;

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`SmartRate: 'limit' must be a positive integer (received: ${limit}).`);
  }

  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`SmartRate: 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`);
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

export function rateLimiter(options = {}) {
  validateOptions(options);

  const { limit, windowMs } = options;
  ensureCleanupTimer();

  return function rateLimiterMiddleware(req, res, next) {
    const now = Date.now();
    const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const routeKey = getRouteIdentifier(req);
    const key = `${clientIp}:${routeKey}`;

    const record = store.get(key);

    if (!record) {
      store.set(key, { count: 1, windowStart: now, windowMs });
      setRateLimitHeaders(res, { limit, remaining: limit - 1, reset: Math.ceil(windowMs / 1000) });
      return next();
    }

    const elapsedTime = now - record.windowStart;

    if (elapsedTime >= windowMs) {
      record.count = 1;
      record.windowStart = now;
      record.windowMs = windowMs;

      setRateLimitHeaders(res, { limit, remaining: limit - 1, reset: Math.ceil(windowMs / 1000) });
      return next();
    }

    if (record.count < limit) {
      record.count += 1;
      const reset = Math.ceil((record.windowStart + windowMs - now) / 1000);
      setRateLimitHeaders(res, { limit, remaining: limit - record.count, reset });
      return next();
    }

    const reset = Math.max(1, Math.ceil((record.windowStart + windowMs - now) / 1000));
    setRateLimitHeaders(res, { limit, remaining: 0, reset, retryAfter: reset });

    return res.status(429).json({
      success: false,
      message: 'Too many requests',
      retryAfter: reset
    });
  };
}

export default rateLimiter;
