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
   * Starts a child tracing span if a tracer is configured.
   *
   * @param {string} [name='smartrate.consume']
   * @param {Object} [options={}]
   * @returns {Object|null}
   */
  startSpan(name = 'smartrate.consume', options = {}) {
    if (this.tracer && typeof this.tracer.startSpan === 'function') {
      try {
        return this.tracer.startSpan(name, options);
      } catch {
        return null;
      }
    }
    return null;
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

    if (req && req.telemetrySpan && typeof req.telemetrySpan.setAttribute === 'function') {
      return req.telemetrySpan;
    }

    if (req && req._smartRateSpan && typeof req._smartRateSpan.setAttribute === 'function') {
      return req._smartRateSpan;
    }

    // Try resolving ambient span via standard OpenTelemetry global symbol
    try {
      const api = globalThis[Symbol.for('opentelemetry.js.api.1')];
      if (api && api.trace && typeof api.trace.getActiveSpan === 'function') {
        const activeSpan = api.trace.getActiveSpan();
        if (activeSpan && typeof activeSpan.setAttribute === 'function') {
          return activeSpan;
        }
      }
    } catch {
      // Safe boundary
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

      const isAllowed = Boolean(result.allowed);
      const remainingVal = typeof result.remaining === 'number' ? result.remaining : 0;
      const resetVal = typeof result.reset === 'number' ? result.reset : 0;
      const algoStr = algorithm || 'fixed-window';
      const routeStr = normalizedRoute || '/';
      const storeStr = store || 'unknown';

      // SmartRate Attributes (backwards compatible)
      span.setAttribute('smartrate.outcome', isAllowed ? 'allowed' : 'blocked');
      span.setAttribute('smartrate.algorithm', algoStr);
      span.setAttribute('smartrate.route', routeStr);
      span.setAttribute('smartrate.store', storeStr);

      if (typeof result.remaining === 'number') {
        span.setAttribute('smartrate.remaining', result.remaining);
      }
      if (typeof result.reset === 'number') {
        span.setAttribute('smartrate.reset', result.reset);
      }
      if (result.degraded) {
        span.setAttribute('smartrate.degraded', true);
      }

      // OpenTelemetry Semantic Conventions for Rate Limiting
      span.setAttribute('ratelimit.allowed', isAllowed);
      span.setAttribute('ratelimit.remaining', remainingVal);
      span.setAttribute('ratelimit.reset', resetVal);
      span.setAttribute('ratelimit.algorithm', algoStr);
      span.setAttribute('ratelimit.store', storeStr);
      span.setAttribute('ratelimit.degraded', Boolean(result.degraded));

      if (result.circuitState) {
        span.setAttribute('ratelimit.circuit_state', result.circuitState);
      }

      if (!isAllowed) {
        if (typeof span.addEvent === 'function') {
          span.addEvent('smartrate.rate_limit_exceeded', {
            'smartrate.retry_after': result.retryAfter || 0,
            'smartrate.route': routeStr,
            'ratelimit.retry_after': result.retryAfter || 0
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
        span.setAttribute('ratelimit.store_error', true);
        span.setAttribute('ratelimit.store', store || 'unknown');
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
