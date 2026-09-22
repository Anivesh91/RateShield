/**
 * SmartRate — In-Memory Fixed Window Rate Limiting Middleware
 */

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

  return function rateLimiterMiddleware(req, res, next) {
    return next();
  };
}

export default rateLimiter;
