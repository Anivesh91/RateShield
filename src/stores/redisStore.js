import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, '../scripts/fixedWindow.lua');
const FIXED_WINDOW_LUA = fs.readFileSync(SCRIPT_PATH, 'utf-8');

/**
 * SmartRate — RedisStore
 *
 * Distributed Fixed Window rate-limiting store backed by Redis.
 * Executes state transitions atomically via an embedded Lua script.
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

    if (typeof options.client.eval !== 'function' && typeof options.client.sendCommand !== 'function') {
      throw new TypeError('SmartRate: Injected Redis client does not appear to be a valid Redis client instance.');
    }

    this.client = options.client;
    this.script = FIXED_WINDOW_LUA;
  }

  /**
   * Executes the atomic Fixed Window Lua script in Redis.
   *
   * @param {string} key - Rate-limit key
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {Promise<[number, number]>} [count, remainingTtlMs]
   * @private
   */
  async _evalScript(key, windowMs) {
    if (typeof this.client.eval === 'function') {
      return this.client.eval(this.script, {
        keys: [key],
        arguments: [String(windowMs)]
      });
    }

    return this.client.sendCommand(['EVAL', this.script, '1', key, String(windowMs)]);
  }

  /**
   * Consumes a request against the Fixed Window quota in Redis atomically via Lua.
   *
   * @param {Object} params
   * @param {string} params.key - Unique rate-limit key
   * @param {number} params.limit - Maximum allowed requests in window
   * @param {number} params.windowMs - Window duration in milliseconds
   * @returns {Promise<{ allowed: boolean, count: number, remaining: number, reset: number, retryAfter?: number }>}
   */
  async consume({ key, limit, windowMs }) {
    const rawResult = await this._evalScript(key, windowMs);
    const [count, ttlMs] = Array.isArray(rawResult) ? rawResult : [1, windowMs];

    const ttl = Number(ttlMs);
    const resetSeconds = Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000));
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
