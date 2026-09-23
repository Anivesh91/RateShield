/**
 * Generates namespaced rate-limit keys: {prefix}:{method}:{normalizedRoute}:{clientIdentifier}
 * Strips query parameters so requests map to the same route quota.
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
