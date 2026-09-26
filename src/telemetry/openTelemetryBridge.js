/**
 * SmartRate — OpenTelemetry Bridge
 *
 * Optional, zero-dependency bridge for OpenTelemetry tracing.
 * Integrates cleanly with OpenTelemetry spans without making
 * @opentelemetry/api a mandatory runtime dependency.
 */

export class OpenTelemetryBridge {
  /**
   * @param {Object} [options={}]
   * @param {Object} [options.tracer] - Optional OpenTelemetry Tracer instance
   * @param {Function} [options.getSpan] - Custom function (req) => span to extract the active span
   */
  constructor(options = {}) {
    this.tracer = options.tracer || null;
    this.getSpan = options.getSpan || null;
  }

  /**
   * Resolves the active OpenTelemetry span for a request.
   *
   * @param {Object} req - Express request
   * @returns {Object|null}
   */
  resolveSpan(req) {
    if (typeof this.getSpan === 'function') {
      try {
        const span = this.getSpan(req);
        if (span && typeof span.setAttribute === 'function') {
          return span;
        }
      } catch {
        return null;
      }
    }

    if (req && req.span && typeof req.span.setAttribute === 'function') {
      return req.span;
    }

    return null;
  }

  /**
   * Records rate limit evaluation outcome and attributes on the active span.
   *
   * @param {Object} params
   * @param {Object} params.req
   * @param {Object} params.result
   * @param {string} params.algorithm
   * @param {string} params.normalizedRoute
   * @param {string} params.store
   */
  recordEvaluation({ req, result, algorithm, normalizedRoute, store }) {
    try {
      const span = this.resolveSpan(req);
      if (!span || typeof span.setAttribute !== 'function') return;

      span.setAttribute('smartrate.outcome', result.allowed ? 'allowed' : 'blocked');
      span.setAttribute('smartrate.algorithm', algorithm || 'fixed-window');
      span.setAttribute('smartrate.route', normalizedRoute || '/');
      span.setAttribute('smartrate.store', store || 'unknown');

      if (typeof result.remaining === 'number') {
        span.setAttribute('smartrate.remaining', result.remaining);
      }
      if (typeof result.reset === 'number') {
        span.setAttribute('smartrate.reset', result.reset);
      }

      if (!result.allowed) {
        if (typeof span.addEvent === 'function') {
          span.addEvent('smartrate.rate_limit_exceeded', {
            'smartrate.retry_after': result.retryAfter || 0,
            'smartrate.route': normalizedRoute || '/'
          });
        }
      }
    } catch {
      // Safe telemetry boundary: telemetry failure must never throw
    }
  }

  /**
   * Records store errors and exceptions on the active span.
   *
   * @param {Object} params
   * @param {Object} params.req
   * @param {Error} params.storeError
   * @param {string} params.store
   */
  recordStoreError({ req, storeError, store }) {
    try {
      const span = this.resolveSpan(req);
      if (!span) return;

      if (typeof span.recordException === 'function' && storeError instanceof Error) {
        span.recordException(storeError);
      }

      if (typeof span.setAttribute === 'function') {
        span.setAttribute('smartrate.store_error', true);
        span.setAttribute('smartrate.store', store || 'unknown');
      }

      if (typeof span.addEvent === 'function') {
        span.addEvent('smartrate.store_error', {
          'error.name': storeError?.name || 'Error',
          'error.message': storeError?.message || 'Store operation failed'
        });
      }
    } catch {
      // Safe telemetry boundary
    }
  }
}
