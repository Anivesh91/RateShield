/**
 * SmartRate — Key Builder
 *
 * Generates predictable, namespaced rate-limiting keys.
 * Format: {prefix}:{method}:{normalizedRoute}:{clientIdentifier}
 * Example: smartrate:POST:/api/login:192.168.1.5
 *
 * Query parameters are explicitly stripped so that requests like:
 *   GET /api/products?page=1
 *   GET /api/products?page=2
 * share the same rate-limiting bucket.
 */

export function buildRateLimitKey({
  prefix = 'smartrate',
  method = 'GET',
  route = '/',
  clientIdentifier = '127.0.0.1'
} = {}) {
  const cleanMethod = (method || 'GET').toUpperCase();
  const cleanRoute = (route || '/').split('?')[0] || '/';
  const cleanId = clientIdentifier || '127.0.0.1';

  return `${prefix}:${cleanMethod}:${cleanRoute}:${cleanId}`;
}

export default buildRateLimitKey;
