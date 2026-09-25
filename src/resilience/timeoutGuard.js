import { StoreTimeoutError } from './errors.js';

/**
 * Wraps an asynchronous store operation with a strict timeout guard.
 *
 * IMPORTANT SEMANTICS:
 * Timing out SmartRate's wait protects the HTTP request and Express pipeline
 * from hanging indefinitely during store latency spikes or network partitions.
 * It does NOT automatically abort or cancel the in-flight network activity
 * inside the underlying database or Redis client driver.
 *
 * @template T
 * @param {Promise<T>|T} operation - Store operation promise
 * @param {number} timeoutMs - Timeout duration in milliseconds
 * @returns {Promise<T>}
 */
export async function withTimeout(operation, timeoutMs) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `SmartRate: 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`
    );
  }

  // Fast path for non-promises or synchronous store returns
  if (!operation || typeof operation.then !== 'function') {
    return operation;
  }

  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new StoreTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}
