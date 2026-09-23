/**
 * SmartRate — RedisStore
 *
 * Distributed Fixed Window rate-limiting store backed by Redis.
 * Injects a pre-connected Redis client from the host application.
 */
export class RedisStore {
  /**
   * @param {Object} options
   * @param {Object} options.client - Connected Redis client instance (e.g. from createClient())
   */
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('SmartRate: RedisStore options must be an object.');
    }

    if (!options.client || typeof options.client !== 'object') {
      throw new TypeError(
        'SmartRate: RedisStore requires a pre-connected Redis client instance (options.client). ' +
        'Please create and connect a Redis client in your application and inject it here.'
      );
    }

    if (typeof options.client.sendCommand !== 'function' && typeof options.client.incr !== 'function') {
      throw new TypeError('SmartRate: Injected Redis client does not appear to be a valid Redis client instance.');
    }

    this.client = options.client;
  }

  /**
   * Consumes a request against the Fixed Window quota in Redis.
   *
   * NOTE: This Day 2 multi-command implementation (INCR -> PEXPIRE -> PTTL) is
   * an intentionally non-atomic intermediate baseline. It illustrates multi-step
   * Redis operations and exposes the failure window / command interleaving
   * that will be solved atomically with Lua in Day 3.
   *
   * @param {Object} params
   * @param {string} params.key
   * @param {number} params.limit
   * @param {number} params.windowMs
   * @returns {Promise<{ allowed: boolean, count: number, remaining: number, reset: number, retryAfter?: number }>}
   */
  async consume({ key, limit, windowMs }) {
    const count = await this.client.incr(key);

    if (count === 1) {
      await this.client.pExpire(key, windowMs);
    }

    let ttlMs = await this.client.pTTL(key);

    if (ttlMs < 0) {
      ttlMs = windowMs;
    }

    const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    return {
      allowed,
      count,
      remaining,
      reset: resetSeconds,
      ...(allowed ? {} : { retryAfter: resetSeconds })
    };
  }
}

export default RedisStore;
