import { EventEmitter } from 'node:events';
import { CircuitBreakerOpenError } from './errors.js';

/**
 * Standard Circuit Breaker state enumeration.
 */
export const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
});

/**
 * In-memory Store Circuit Breaker.
 *
 * Implements the standard three-state pattern (CLOSED, OPEN, HALF_OPEN)
 * to prevent hammering unhealthy or timing out rate-limiting stores (e.g. Redis).
 *
 * Transitions:
 * Transitions:
 * - CLOSED    -> OPEN: When consecutive store failures exceed failureThreshold.
 * - OPEN      -> HALF_OPEN: Lazy on-demand transition evaluated when next request arrives after resetTimeoutMs has elapsed.
 * - HALF_OPEN -> CLOSED: When a single-flight canary probe succeeds.
 * - HALF_OPEN -> OPEN: When a canary probe fails.
 */
export class CircuitBreaker extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.failureThreshold=5] - Consecutive failures before opening the circuit
   * @param {number} [options.resetTimeoutMs=10000] - Duration in ms before transitioning from OPEN to HALF_OPEN
   * @param {number} [options.successThreshold=1] - Consecutive successful probes in HALF_OPEN to close the circuit
   * @param {(err: Error) => boolean} [options.isFailure] - Optional predicate to classify if an error counts towards circuit trip
   */
  constructor(options = {}) {
    super();

    const {
      failureThreshold = 5,
      resetTimeoutMs = 10000,
      successThreshold = 1,
      isFailure = () => true
    } = options;

    if (typeof failureThreshold !== 'number' || !Number.isInteger(failureThreshold) || failureThreshold <= 0) {
      throw new RangeError(
        `SmartRate: CircuitBreaker 'failureThreshold' must be a positive integer (received: ${failureThreshold}).`
      );
    }

    if (typeof resetTimeoutMs !== 'number' || !Number.isFinite(resetTimeoutMs) || resetTimeoutMs <= 0) {
      throw new RangeError(
        `SmartRate: CircuitBreaker 'resetTimeoutMs' must be a positive number in milliseconds (received: ${resetTimeoutMs}).`
      );
    }

    if (typeof successThreshold !== 'number' || !Number.isInteger(successThreshold) || successThreshold <= 0) {
      throw new RangeError(
        `SmartRate: CircuitBreaker 'successThreshold' must be a positive integer (received: ${successThreshold}).`
      );
    }

    if (typeof isFailure !== 'function') {
      throw new TypeError("SmartRate: CircuitBreaker 'isFailure' must be a function.");
    }

    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.successThreshold = successThreshold;
    this.isFailure = isFailure;

    this.state = CIRCUIT_STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = null;
    this.nextAttempt = 0;
    this.probeInFlight = false;
  }

  /**
   * Returns the current circuit state, lazily evaluating OPEN -> HALF_OPEN timeout expiration.
   *
   * @returns {'CLOSED'|'OPEN'|'HALF_OPEN'}
   */
  getState() {
    if (this.state === CIRCUIT_STATE.OPEN && Date.now() >= this.nextAttempt) {
      this._transitionTo(CIRCUIT_STATE.HALF_OPEN);
    }
    return this.state;
  }

  /**
   * Checks whether the circuit is currently OPEN (blocking calls).
   *
   * @returns {boolean}
   */
  isOpen() {
    return this.getState() === CIRCUIT_STATE.OPEN;
  }

  /**
   * Checks whether the circuit is currently CLOSED (normal operation).
   *
   * @returns {boolean}
   */
  isClosed() {
    return this.getState() === CIRCUIT_STATE.CLOSED;
  }

  /**
   * Checks whether the circuit is currently HALF_OPEN (canary probe phase).
   *
   * @returns {boolean}
   */
  isHalfOpen() {
    return this.getState() === CIRCUIT_STATE.HALF_OPEN;
  }

  /**
   * Internal transition handler that updates state and emits events.
   *
   * @private
   * @param {'CLOSED'|'OPEN'|'HALF_OPEN'} nextState
   * @param {Object} [context]
   */
  _transitionTo(nextState, context = {}) {
    if (this.state === nextState) return;

    const from = this.state;
    this.state = nextState;

    if (nextState === CIRCUIT_STATE.CLOSED) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.probeInFlight = false;
    } else if (nextState === CIRCUIT_STATE.OPEN) {
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      this.probeInFlight = false;
    } else if (nextState === CIRCUIT_STATE.HALF_OPEN) {
      this.consecutiveSuccesses = 0;
      this.probeInFlight = false;
    }

    const eventPayload = {
      from,
      to: nextState,
      timestamp: Date.now(),
      ...context
    };

    this.emit('stateChange', eventPayload);

    if (nextState === CIRCUIT_STATE.OPEN) {
      this.emit('open', eventPayload);
      this.emit('trip', eventPayload);
    } else if (nextState === CIRCUIT_STATE.HALF_OPEN) {
      this.emit('halfOpen', eventPayload);
    } else if (nextState === CIRCUIT_STATE.CLOSED) {
      this.emit('close', eventPayload);
      this.emit('reset', eventPayload);
    }
  }

  /**
   * Wraps an async store operation with circuit breaker protection.
   *
   * @template T
   * @param {() => Promise<T>|T} fn - Store operation factory
   * @returns {Promise<T>}
   */
  async execute(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError("SmartRate: CircuitBreaker.execute() expects a function argument.");
    }

    const currentState = this.getState();

    if (currentState === CIRCUIT_STATE.OPEN) {
      const remainingMs = Math.max(0, this.nextAttempt - Date.now());
      throw new CircuitBreakerOpenError(
        `SmartRate: Circuit breaker is OPEN. Fast-failing without calling store (resets in ${remainingMs}ms).`,
        remainingMs
      );
    }

    if (currentState === CIRCUIT_STATE.HALF_OPEN) {
      if (this.probeInFlight) {
        throw new CircuitBreakerOpenError(
          'SmartRate: Circuit breaker is HALF_OPEN and a canary probe is already in-flight.',
          Math.max(0, this.nextAttempt - Date.now())
        );
      }
      this.probeInFlight = true;
      this.emit('probe', { timestamp: Date.now() });
    }

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) {
        this._recordFailure(err);
      }
      throw err;
    } finally {
      if (this.state === CIRCUIT_STATE.HALF_OPEN) {
        this.probeInFlight = false;
      }
    }
  }

  /**
   * Records a successful execution.
   *
   * @private
   */
  _recordSuccess() {
    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this._transitionTo(CIRCUIT_STATE.CLOSED);
      }
    } else if (this.state === CIRCUIT_STATE.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Records a failed execution.
   *
   * @private
   * @param {Error} err
   */
  _recordFailure(err) {
    this.lastFailureTime = Date.now();
    this.consecutiveFailures += 1;

    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this._transitionTo(CIRCUIT_STATE.OPEN, { error: err, probeFailed: true });
    } else if (this.state === CIRCUIT_STATE.CLOSED) {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this._transitionTo(CIRCUIT_STATE.OPEN, { error: err, consecutiveFailures: this.consecutiveFailures });
      }
    }
  }

  /**
   * Manually trips the circuit into OPEN state.
   *
   * @param {Error} [error]
   */
  trip(error) {
    this._transitionTo(CIRCUIT_STATE.OPEN, { error, manual: true });
  }

  /**
   * Manually resets the circuit into CLOSED state.
   */
  reset() {
    this._transitionTo(CIRCUIT_STATE.CLOSED, { manual: true });
  }

  /**
   * Returns a snapshot of circuit breaker metrics and internal state.
   *
   * @returns {Object}
   */
  getStats() {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      successThreshold: this.successThreshold,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      probeInFlight: this.probeInFlight
    };
  }
}
