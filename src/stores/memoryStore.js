/**
 * SmartRate — MemoryStore
 *
 * In-memory rate-limiting store backed by a JavaScript Map.
 * Supports both Fixed Window and Rolling Sliding Window algorithms.
 * Encapsulates state tracking, rolling window expiration, and periodic stale-entry cleanup.
 *
 * Implements the SmartRate Store contract: consume({ key, limit, windowMs, algorithm }).
 */
export class MemoryStore {
  /**
   * @param {Object} [options]
   * @param {number} [options.cleanupIntervalMs=60000] Interval in ms to run stale entry cleanup
   */
  constructor(options = {}) {
    this.store = new Map();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60_000;
    this.cleanupInterval = null;
    this._ensureCleanupTimer();
  }

  /**
   * Consumes a request against the rate-limit quota for a given key.
   * Dispatches to algorithm-specific storage strategies.
   *
   * @param {Object} params
   * @param {string} params.key - Unique rate-limit key (e.g. smartrate:fixed-window:GET:/api:127.0.0.1)
   * @param {number} params.limit - Maximum allowed requests in the window
   * @param {number} params.windowMs - Window duration in milliseconds
   * @param {'fixed-window'|'sliding-window'} [params.algorithm='fixed-window'] - Selected algorithm
   * @param {number} [params.now=Date.now()] - Timestamp hook for deterministic testing
   * @returns {{ allowed: boolean, count: number, remaining: number, reset: number, retryAfter?: number }}
   */
  consume({ key, limit, windowMs, algorithm = 'fixed-window', now = Date.now() }) {
    if (algorithm === 'sliding-window') {
      return this._consumeSlidingWindow({ key, limit, windowMs, now });
    }
    return this._consumeFixedWindow({ key, limit, windowMs, now });
  }

  /**
   * Fixed Window strategy: Evaluates requests within fixed time buckets.
   * @private
   */
  _consumeFixedWindow({ key, limit, windowMs, now }) {
    const record = this.store.get(key);

    if (!record || record.windowStart === undefined) {
      this.store.set(key, { count: 1, windowStart: now, windowMs });
      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        reset: Math.ceil(windowMs / 1000)
      };
    }

    const elapsedTime = now - record.windowStart;

    if (elapsedTime >= windowMs) {
      record.count = 1;
      record.windowStart = now;
      record.windowMs = windowMs;

      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        reset: Math.ceil(windowMs / 1000)
      };
    }

    if (record.count < limit) {
      record.count += 1;
      const reset = Math.max(1, Math.ceil((record.windowStart + windowMs - now) / 1000));

      return {
        allowed: true,
        count: record.count,
        remaining: Math.max(0, limit - record.count),
        reset
      };
    }

    const reset = Math.max(1, Math.ceil((record.windowStart + windowMs - now) / 1000));

    return {
      allowed: false,
      count: record.count,
      remaining: 0,
      reset,
      retryAfter: reset
    };
  }

  /**
   * Sliding Window strategy: Evaluates requests within a rolling interval (now - windowMs, now].
   * Maintains a queue of request timestamps and prunes timestamps <= (now - windowMs).
   * @private
   */
  _consumeSlidingWindow({ key, limit, windowMs, now }) {
    const cutoff = now - windowMs;

    let record = this.store.get(key);
    if (!record || !Array.isArray(record.timestamps)) {
      record = { timestamps: [], windowMs };
      this.store.set(key, record);
    } else {
      record.windowMs = windowMs;
    }

    // Prune expired timestamps falling outside active interval (cutoff < t <= now)
    while (record.timestamps.length > 0 && record.timestamps[0] <= cutoff) {
      record.timestamps.shift();
    }

    const currentCount = record.timestamps.length;

    if (currentCount < limit) {
      record.timestamps.push(now);
      const newCount = currentCount + 1;
      const remaining = Math.max(0, limit - newCount);

      // Oldest timestamp in window determines seconds until initial slot opens
      const oldestTimestamp = record.timestamps[0];
      const reset = Math.max(1, Math.ceil((oldestTimestamp + windowMs - now) / 1000));

      return {
        allowed: true,
        count: newCount,
        remaining,
        reset
      };
    }

    // Quota exhausted: determine seconds until oldest timestamp exits the window
    const oldestTimestamp = record.timestamps[0];
    const reset = Math.max(1, Math.ceil((oldestTimestamp + windowMs - now) / 1000));

    return {
      allowed: false,
      count: currentCount,
      remaining: 0,
      reset,
      retryAfter: reset
    };
  }

  /**
   * Scans the Map and removes records whose windows have elapsed.
   * For Sliding Window: prunes expired timestamps and deletes empty keys.
   * For Fixed Window: deletes keys whose fixed bucket has elapsed.
   * Returns the count of removed stale records.
   *
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  cleanupExpiredRecords(now = Date.now()) {
    let removed = 0;

    for (const [key, record] of this.store.entries()) {
      if (Array.isArray(record.timestamps)) {
        const cutoff = now - record.windowMs;
        while (record.timestamps.length > 0 && record.timestamps[0] <= cutoff) {
          record.timestamps.shift();
        }
        if (record.timestamps.length === 0) {
          this.store.delete(key);
          removed++;
        }
      } else if (record.windowStart !== undefined) {
        if (now - record.windowStart >= record.windowMs) {
          this.store.delete(key);
          removed++;
        }
      }
    }

    return removed;
  }

  _ensureCleanupTimer() {
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredRecords();
      }, this.cleanupIntervalMs);

      // unref() ensures background timer does not keep Node.js event loop alive
      if (typeof this.cleanupInterval.unref === 'function') {
        this.cleanupInterval.unref();
      }
    }
  }

  /**
   * Stops background cleanup timer and clears in-memory state.
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

export default MemoryStore;
