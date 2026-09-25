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
