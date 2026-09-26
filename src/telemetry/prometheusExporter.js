import {
  METRIC_TYPE,
  METRIC_NAMES,
  METRIC_METADATA
} from './telemetryEvents.js';
import { defaultMetricsCollector } from './metricsCollector.js';

/**
 * Escapes label values according to Prometheus text exposition format (v0.0.4).
 *
 * @param {string|number|boolean} value
 * @returns {string}
 */
export function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Escapes help strings according to Prometheus text exposition format.
 *
 * @param {string} help
 * @returns {string}
 */
export function escapeHelpString(help) {
  return String(help)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n');
}

/**
 * Formats a labels object into a Prometheus label string.
 * e.g. { outcome: 'allowed', store: 'memory' } -> '{outcome="allowed",store="memory"}'
 *
 * @param {Object} [labels={}]
 * @param {Object} [additionalLabels={}]
 * @returns {string}
 */
export function formatLabels(labels = {}, additionalLabels = {}) {
  const merged = { ...labels, ...additionalLabels };
  const entries = Object.entries(merged).filter(
    ([, v]) => v !== undefined && v !== null
  );

  if (entries.length === 0) {
    return '';
  }

  // Sort labels deterministically for scrape consistency
  entries.sort(([a], [b]) => a.localeCompare(b));

  const formatted = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');

  return `{${formatted}}`;
}

/**
 * Serializes an in-memory metrics snapshot to standard Prometheus text exposition format (v0.0.4).
 *
 * @param {Object} snapshot - Metrics snapshot from MetricsCollector.getSnapshot()
 * @returns {string} Prometheus exposition text
 */
export function formatPrometheusMetrics(snapshot = {}) {
  const lines = [];
  const { counters = {}, gauges = {}, histograms = {} } = snapshot;

  // 1. Format Counters
  for (const [name, records] of Object.entries(counters)) {
    if (!Array.isArray(records) || records.length === 0) continue;

    const meta = METRIC_METADATA[name] || {
      type: METRIC_TYPE.COUNTER,
      help: `Counter metric ${name}`
    };

    lines.push(`# HELP ${name} ${escapeHelpString(meta.help)}`);
    lines.push(`# TYPE ${name} ${meta.type}`);

    for (const record of records) {
      const labelStr = formatLabels(record.labels);
      lines.push(`${name}${labelStr} ${record.value}`);
    }
  }

  // 2. Format Gauges
  for (const [name, records] of Object.entries(gauges)) {
    if (!Array.isArray(records) || records.length === 0) continue;

    const meta = METRIC_METADATA[name] || {
      type: METRIC_TYPE.GAUGE,
      help: `Gauge metric ${name}`
    };

    lines.push(`# HELP ${name} ${escapeHelpString(meta.help)}`);
    lines.push(`# TYPE ${name} ${meta.type}`);

    for (const record of records) {
      const labelStr = formatLabels(record.labels);
      lines.push(`${name}${labelStr} ${record.value}`);
    }
  }

  // 3. Format Histograms
  for (const [name, records] of Object.entries(histograms)) {
    if (!Array.isArray(records) || records.length === 0) continue;

    const meta = METRIC_METADATA[name] || {
      type: METRIC_TYPE.HISTOGRAM,
      help: `Histogram metric ${name}`
    };

    lines.push(`# HELP ${name} ${escapeHelpString(meta.help)}`);
    lines.push(`# TYPE ${name} ${meta.type}`);

    for (const record of records) {
      const baseLabels = record.labels || {};

      // Buckets
      if (Array.isArray(record.buckets)) {
        for (const bucket of record.buckets) {
          const bucketLabels = formatLabels(baseLabels, { le: bucket.le });
          lines.push(`${name}_bucket${bucketLabels} ${bucket.count}`);
        }
      }

      // +Inf bucket (matches total count)
      const infLabels = formatLabels(baseLabels, { le: '+Inf' });
      lines.push(`${name}_bucket${infLabels} ${record.count}`);

      // _sum and _count
      const sumLabels = formatLabels(baseLabels);
      lines.push(`${name}_sum${sumLabels} ${record.sum}`);
      lines.push(`${name}_count${sumLabels} ${record.count}`);
    }
  }

  // Prometheus exposition format requires a trailing newline
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Creates an Express middleware handler that exposes Prometheus metrics at a scrape endpoint.
 *
 * @param {Object} [options={}]
 * @param {import('./metricsCollector.js').MetricsCollector} [options.collector] - Collector instance
 * @returns {import('express').RequestHandler}
 */
export function createPrometheusExporter(options = {}) {
  const collector = options.collector || options.metricsCollector || defaultMetricsCollector;

  return function prometheusExporterMiddleware(req, res, next) {
    try {
      const snapshot = collector.getSnapshot();
      const output = formatPrometheusMetrics(snapshot);

      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.status(200).end(output);
    } catch (err) {
      next(err);
    }
  };
}
