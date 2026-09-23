/**
 * SmartRate — MemoryStore
 *
 * In-memory Fixed Window store backed by a JavaScript Map.
 * Encapsulates state tracking, window expiration, and periodic stale-entry cleanup.
 * Implements the SmartRate Store contract: consume({ key, limit, windowMs }).
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
   * Consumes a request against the Fixed Window quota for a given key.
   *
   * @param {Object} params
   * @param {string} params.key - Unique rate-limit key (e.g. smartrate:POST:/api/login:127.0.0.1)
   * @param {number} params.limit - Maximum allowed requests in the window
   * @param {number} params.windowMs - Window duration in milliseconds
   * @returns {{ allowed: boolean, count: number, remaining: number, reset: number, retryAfter?: number }}
   */
  consume({ key, limit, windowMs }) {
    const now = Date.now();
    const record = this.store.get(key);

    // Scenario 1: First request in window
    if (!record) {
      this.store.set(key, { count: 1, windowStart: now, windowMs });
      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        reset: Math.ceil(windowMs / 1000)
      };
    }

    const elapsedTime = now - record.windowStart;

    // Scenario 2: Previous window elapsed -> Reset window with fresh count
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

    // Scenario 3: Within active window and within quota -> Increment count
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

    // Scenario 4: Quota exhausted -> Block request
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
   * Scans the Map and removes records whose Fixed Windows have elapsed.
   * Returns the count of removed stale records.
   *
   * @returns {number}
   */
  cleanupExpiredRecords() {
    const now = Date.now();
    let removed = 0;

    for (const [key, record] of this.store.entries()) {
      if (now - record.windowStart >= record.windowMs) {
        this.store.delete(key);
        removed++;
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
