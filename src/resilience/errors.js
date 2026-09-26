/**
 * Error thrown when a rate-limiting store operation exceeds the configured timeout threshold.
 */
export class StoreTimeoutError extends Error {
  /**
   * @param {number} [timeoutMs=250] - Configured timeout threshold in milliseconds
   * @param {string} [message] - Optional custom error message
   */
  constructor(timeoutMs = 250, message) {
    super(message || `SmartRate: Rate limit store operation timed out after ${timeoutMs}ms.`);
    this.name = 'StoreTimeoutError';
    this.isTimeout = true;
    this.code = 'ERR_STORE_TIMEOUT';
    this.timeoutMs = timeoutMs;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StoreTimeoutError);
    }
  }
}

/**
 * Error thrown when a store operation is blocked because the Circuit Breaker is in OPEN state.
 */
export class CircuitBreakerOpenError extends Error {
  /**
   * @param {string} [message] - Optional custom error message
   * @param {number} [resetTimeoutMs] - Remaining or configured reset timeout duration
   */
  constructor(message, resetTimeoutMs) {
    super(message || 'SmartRate: Circuit breaker is OPEN. Store operations temporarily suspended.');
    this.name = 'CircuitBreakerOpenError';
    this.isCircuitOpen = true;
    this.code = 'ERR_CIRCUIT_OPEN';
    if (resetTimeoutMs !== undefined) {
      this.resetTimeoutMs = resetTimeoutMs;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CircuitBreakerOpenError);
    }
  }
}

