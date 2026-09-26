import { EventEmitter } from 'node:events';
import { MemoryStore } from './memoryStore.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { withTimeout } from '../resilience/timeoutGuard.js';

/**
 * SmartRate — ResilientStore
 *
 * Dual-store resilience wrapper combining a primary distributed store (e.g. RedisStore)
 * with an automatic fallback local store (e.g. MemoryStore).
 *
 * Architecture:
 * - When primaryStore is healthy: All operations execute against primaryStore (distributed state).
 * - When primaryStore fails or times out: Operation fails over transparently to fallbackStore (local state).
 * - When CircuitBreaker is OPEN: primaryStore calls are completely bypassed (zero network hammering);
 *   traffic is served directly from fallbackStore.
 * - When CircuitBreaker is HALF_OPEN: A single-flight canary probe tests primaryStore. If successful,
 *   traffic recovers seamlessly back to primaryStore. If failed, traffic remains on fallbackStore.
 *
 * CRITICAL V6 BOUNDARY:
 * Local memory quotas are NOT backfilled or synchronized into Redis upon recovery.
 * In a multi-instance cluster, in-memory quotas apply per-process during degraded failover.
 * Timed-out primary consume operations are not cancelled and may complete after fallback
 * consumption, potentially counting the same request twice; stores currently have no cancellation path.
 */
export class ResilientStore extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.primaryStore - Primary distributed store (must implement consume())
   * @param {Object} [options.fallbackStore] - Local fallback store (defaults to new MemoryStore())
   * @param {CircuitBreaker|Object|boolean} [options.circuitBreaker] - Circuit breaker instance or options
   * @param {number} [options.timeoutMs=250] - Primary store operation timeout in milliseconds
   * @param {number} [options.failureThreshold=5] - Consecutive failures before opening circuit
   * @param {number} [options.resetTimeoutMs=10000] - Duration in ms before testing recovery in HALF_OPEN
   */
  constructor(options = {}) {
    super();

    if (!options || typeof options !== 'object') {
      throw new TypeError('SmartRate: ResilientStore options must be an object.');
    }

    const {
      primaryStore,
      fallbackStore,
      circuitBreaker,
      timeoutMs = 250,
      failureThreshold = 5,
      resetTimeoutMs = 10000
    } = options;

    if (!primaryStore || typeof primaryStore.consume !== 'function') {
      throw new TypeError("SmartRate: ResilientStore requires a 'primaryStore' implementing a consume() method.");
    }
    this.primaryStore = primaryStore;

    if (fallbackStore !== undefined) {
      if (!fallbackStore || typeof fallbackStore.consume !== 'function') {
        throw new TypeError("SmartRate: ResilientStore 'fallbackStore' must implement a consume() method.");
      }
      this.fallbackStore = fallbackStore;
    } else {
      this.fallbackStore = new MemoryStore();
    }

    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError(
        `SmartRate: ResilientStore 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`
      );
    }
    this.timeoutMs = timeoutMs;

    if (circuitBreaker instanceof CircuitBreaker) {
      this.circuitBreaker = circuitBreaker;
    } else if (typeof circuitBreaker === 'object' && circuitBreaker !== null) {
      this.circuitBreaker = new CircuitBreaker(circuitBreaker);
    } else if (circuitBreaker === false) {
      this.circuitBreaker = null;
    } else {
      this.circuitBreaker = new CircuitBreaker({ failureThreshold, resetTimeoutMs });
    }

    if (this.circuitBreaker) {
      this.circuitBreaker.on('stateChange', (evt) => this.emit('stateChange', evt));
      this.circuitBreaker.on('trip', (evt) => this.emit('circuitOpen', evt));
      this.circuitBreaker.on('close', (evt) => this.emit('circuitClose', evt));
      this.circuitBreaker.on('probe', (evt) => this.emit('probe', evt));
    }
  }

  /**
   * Consumes quota using primaryStore, falling back gracefully to fallbackStore upon failure.
   *
   * @param {Object} params - Store consume parameters
   * @returns {Promise<Object>} Rate limit result with resilience metadata
   */
  async consume(params) {
    const runPrimary = () =>
      this.timeoutMs
        ? withTimeout(this.primaryStore.consume(params), this.timeoutMs)
        : this.primaryStore.consume(params);

    let primaryError = null;

    try {
      const primaryResult = this.circuitBreaker
        ? await this.circuitBreaker.execute(runPrimary)
        : await runPrimary();

      this.emit('primarySuccess', { key: params.key });

      return {
        ...primaryResult,
        degraded: false,
        fallbackUsed: false,
        store: 'primary'
      };
    } catch (err) {
      primaryError = err;
    }

    // Primary store failed, timed out, or circuit breaker blocked execution
    this.emit('fallback', {
      key: params.key,
      error: primaryError,
      circuitState: this.circuitBreaker ? this.circuitBreaker.getState() : 'NONE'
    });

    const fallbackResult = await this.fallbackStore.consume(params);

    return {
      ...fallbackResult,
      degraded: true,
      fallbackUsed: true,
      store: 'fallback',
      primaryError
    };
  }

  /**
   * Evicts expired records across both stores.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Total evicted entries
   */
  cleanupExpiredRecords(now) {
    let cleaned = 0;
    if (typeof this.primaryStore.cleanupExpiredRecords === 'function') {
      cleaned += this.primaryStore.cleanupExpiredRecords(now) || 0;
    }
    if (typeof this.fallbackStore.cleanupExpiredRecords === 'function') {
      cleaned += this.fallbackStore.cleanupExpiredRecords(now) || 0;
    }
    return cleaned;
  }

  /**
   * Returns a snapshot of ResilientStore health and breaker metrics.
   *
   * @returns {Object}
   */
  getStats() {
    return {
      circuitBreaker: this.circuitBreaker ? this.circuitBreaker.getStats() : null,
      timeoutMs: this.timeoutMs,
      hasFallbackStore: Boolean(this.fallbackStore)
    };
  }
}
