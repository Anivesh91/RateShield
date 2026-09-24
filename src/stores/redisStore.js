import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXED_SCRIPT_PATH = path.join(__dirname, '../scripts/fixedWindow.lua');
const FIXED_WINDOW_LUA = fs.readFileSync(FIXED_SCRIPT_PATH, 'utf-8');

const SLIDING_SCRIPT_PATH = path.join(__dirname, '../scripts/slidingWindow.lua');
const SLIDING_WINDOW_LUA = fs.readFileSync(SLIDING_SCRIPT_PATH, 'utf-8');

/**
 * SmartRate — RedisStore
 *
 * Distributed rate-limiting store backed by Redis.
 * Supports both Fixed Window and Rolling Sliding Window algorithms.
 * Executes state transitions atomically via embedded Lua scripts.
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
    this.fixedScript = FIXED_WINDOW_LUA;
    this.slidingScript = SLIDING_WINDOW_LUA;
  }

  /**
   * Executes the atomic Fixed Window Lua script in Redis.
   *
   * @param {string} key - Rate-limit key
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {Promise<[number, number]>} [count, remainingTtlMs]
   * @private
   */
  async _evalFixedScript(key, windowMs) {
    if (typeof this.client.eval === 'function') {
      return this.client.eval(this.fixedScript, {
        keys: [key],
        arguments: [String(windowMs)]
      });
    }

    return this.client.sendCommand(['EVAL', this.fixedScript, '1', key, String(windowMs)]);
  }

  /**
   * Executes the atomic Sliding Window Lua script in Redis.
   *
   * @param {string} key - Rate-limit key
   * @param {number} now - Timestamp in milliseconds
   * @param {number} windowMs - Window duration in milliseconds
   * @param {number} limit - Maximum allowed requests in window
   * @param {string} member - Collision-resistant unique member identifier
   * @returns {Promise<[number, number, number]>} [allowed (1 or 0), count, oldestScore]
   * @private
   */
  async _evalSlidingScript(key, now, windowMs, limit, member) {
    if (typeof this.client.eval === 'function') {
      return this.client.eval(this.slidingScript, {
        keys: [key],
        arguments: [String(now), String(windowMs), String(limit), member]
      });
    }

    return this.client.sendCommand([
      'EVAL',
      this.slidingScript,
      '1',
      key,
      String(now),
      String(windowMs),
      String(limit),
      member
    ]);
  }

  /**
   * Consumes a request against the rate-limit quota in Redis atomically via Lua.
   *
   * @param {Object} params
   * @param {string} params.key - Unique rate-limit key
   * @param {number} params.limit - Maximum allowed requests in window
   * @param {number} params.windowMs - Window duration in milliseconds
   * @param {'fixed-window'|'sliding-window'} [params.algorithm='fixed-window'] - Selected algorithm
   * @param {number} [params.now=Date.now()] - Timestamp hook for deterministic testing
   * @returns {Promise<{ allowed: boolean, count: number, remaining: number, reset: number, retryAfter?: number }>}
   */
  async consume({ key, limit, windowMs, algorithm = 'fixed-window', now = Date.now() }) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new TypeError("SmartRate: RedisStore 'key' must be a non-empty string.");
    }

    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`SmartRate: RedisStore 'limit' must be a positive integer (received: ${limit}).`);
    }

    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`SmartRate: RedisStore 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`);
    }

    if (algorithm === 'sliding-window') {
      return this._consumeSlidingWindow({ key, limit, windowMs, now });
    }

    return this._consumeFixedWindow({ key, limit, windowMs });
  }

  async _consumeFixedWindow({ key, limit, windowMs }) {
    const rawResult = await this._evalFixedScript(key, windowMs);
    const [rawCount, rawTtlMs] = Array.isArray(rawResult) ? rawResult : [1, windowMs];

    const count = Number(rawCount);
    const ttlMs = Number(rawTtlMs);

    if (ttlMs === -1) {
      throw new Error(`SmartRate: Key '${key}' exists in Redis without an expiration TTL.`);
    }

    const resetSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000));
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

  async _consumeSlidingWindow({ key, limit, windowMs, now }) {
    const uniqueId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
    const member = `${now}:${uniqueId}`;

    const rawResult = await this._evalSlidingScript(key, now, windowMs, limit, member);
    const [rawAllowed, rawCount, rawOldestScore] = Array.isArray(rawResult) ? rawResult : [1, 1, now];

    const allowed = Number(rawAllowed) === 1;
    const count = Number(rawCount);
    const oldestScore = Number(rawOldestScore);
    const remaining = Math.max(0, limit - count);

    const resetMs = (oldestScore + windowMs) - now;
    const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));

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
