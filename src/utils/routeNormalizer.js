/**
 * SmartRate — Route Normalizer
 *
 * Normalizes HTTP route paths to prevent Prometheus metric cardinality explosion.
 *
 * Critical Cardinality Guard:
 * Express URLs often contain dynamic entity IDs (e.g. /users/83921 or /orders/c9a3-4...).
 * Exposing raw URLs as metric labels causes unbounded memory growth in metric systems.
 *
 * Strategy:
 * 1. Prefer Express route pattern if available (req.baseUrl + req.route.path -> e.g. /users/:id).
 * 2. Fall back to regex-based path sanitization (replacing numeric IDs, UUIDs, and long hashes with ':id').
 * 3. Support custom normalizer function provided by the developer.
 */

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_SEGMENT_REGEX = /\/\d+(?=\/|$)/g;
const LONG_HEX_HASH_REGEX = /\/[0-9a-fA-F]{16,}(?=\/|$)/g;

/**
 * Sanitizes a raw path by replacing dynamic identifiers with ':id'.
 *
 * @param {string} rawPath
 * @returns {string} Sanitized route template
 */
export function sanitizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return '/';
  }

  // Strip query parameters
  const pathWithoutQuery = rawPath.split('?')[0];

  const sanitized = pathWithoutQuery
    .replace(UUID_REGEX, ':id')
    .replace(NUMERIC_SEGMENT_REGEX, '/:id')
    .replace(LONG_HEX_HASH_REGEX, '/:id')
    .replace(/\/+/g, '/');

  return sanitized || '/';
}

/**
 * Extracts and normalizes an Express request route for telemetry labels.
 *
 * @param {Object} req - Express request object
 * @param {Function} [customNormalizer] - Optional custom route normalization function
 * @returns {string} Normalized route label
 */
export function normalizeRoute(req, customNormalizer) {
  if (typeof customNormalizer === 'function') {
    try {
      const custom = customNormalizer(req);
      if (typeof custom === 'string' && custom.length > 0) {
        return sanitizePath(custom);
      }
    } catch {
      // Fall through on custom normalizer error to maintain cardinality guard
    }
  }

  if (!req || typeof req !== 'object') {
    return '/';
  }

  // Express router provides req.baseUrl + req.route.path when matched
  if (req.route && typeof req.route.path === 'string') {
    const base = req.baseUrl || '';
    const route = req.route.path;
    const combined = `${base}${route}`.replace(/\/+/g, '/');
    return combined || '/';
  }

  // Fallback to sanitizing req.baseUrl + (req.path || req.originalUrl)
  const fallbackPath = `${req.baseUrl || ''}${req.path || req.originalUrl || '/'}`;
  return sanitizePath(fallbackPath);
}
