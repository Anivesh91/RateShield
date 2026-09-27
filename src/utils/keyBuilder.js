import crypto from 'node:crypto';

export const MAX_IDENTIFIER_LENGTH = 256;

/**
 * Generates namespaced rate-limit keys: {prefix}:{algorithm}:{method}:{normalizedRoute}:{clientIdentifier}
 * Strips query parameters so requests map to the same route quota.
 *
 * Security & Pathological Guards:
 * - Binds clientIdentifier length to MAX_IDENTIFIER_LENGTH (256 chars) to prevent memory bloat.
 * - Supports optional cryptographic SHA-256 hashing (hashClientIdentifier: true) so sensitive
 *   API keys, Bearer tokens, or PII are never stored in plaintext within Redis keys.
 */
export function buildRateLimitKey({
  prefix = 'smartrate',
  algorithm = 'fixed-window',
  method = 'GET',
  route = '/',
  clientIdentifier = '127.0.0.1',
  hashClientIdentifier = false
} = {}) {
  const cleanMethod = (method || 'GET').toUpperCase();
  const cleanRoute = (route || '/').split('?')[0] || '/';
  const rawId = (clientIdentifier !== undefined && clientIdentifier !== null && String(clientIdentifier).trim().length > 0)
    ? String(clientIdentifier).trim()
    : '127.0.0.1';

  // Defensive length bounding against memory bloat attacks
  const boundedId = rawId.length > MAX_IDENTIFIER_LENGTH ? rawId.slice(0, MAX_IDENTIFIER_LENGTH) : rawId;

  // Optional cryptographic hashing
  let cleanId = boundedId;
  if (hashClientIdentifier === true) {
    cleanId = crypto.createHash('sha256').update(boundedId).digest('hex');
  } else if (typeof hashClientIdentifier === 'function') {
    cleanId = String(hashClientIdentifier(boundedId) || boundedId);
  }

  if (algorithm && algorithm !== 'fixed-window') {
    return `${prefix}:${algorithm}:${cleanMethod}:${cleanRoute}:${cleanId}`;
  }

  return `${prefix}:${cleanMethod}:${cleanRoute}:${cleanId}`;
}

export default buildRateLimitKey;
