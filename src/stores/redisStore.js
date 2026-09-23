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

    // Verify basic interface of the injected Redis client
    if (typeof options.client.sendCommand !== 'function' && typeof options.client.incr !== 'function') {
      throw new TypeError('SmartRate: Injected Redis client does not appear to be a valid Redis client instance.');
    }

    this.client = options.client;
  }

  /**
   * Consumes a request against the Fixed Window quota in Redis.
   */
  async consume({ key, limit, windowMs }) {
    throw new Error('SmartRate: RedisStore.consume() will be activated in Day 2.');
  }
}

export default RedisStore;
