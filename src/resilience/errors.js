/**
 * Error thrown when a rate-limiting store operation exceeds the configured timeout threshold.
 */
export class StoreTimeoutError extends Error {
  /**
   * @param {number} timeoutMs - Configured timeout threshold in milliseconds
   */
  constructor(timeoutMs) {
    super(`SmartRate: Rate limit store operation timed out after ${timeoutMs}ms.`);
    this.name = 'StoreTimeoutError';
    this.isTimeout = true;
    this.code = 'ERR_STORE_TIMEOUT';
    this.timeoutMs = timeoutMs;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StoreTimeoutError);
    }
  }
}
