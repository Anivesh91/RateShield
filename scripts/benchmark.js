#!/usr/bin/env node
import { runBenchmark } from '../src/benchmark/benchmarkRunner.js';

async function main() {
  console.log('================================================================================');
  console.log('   SmartRate V7 — High-Precision Performance & Overhead Benchmark');
  console.log('================================================================================');
  console.log(`Node.js:  ${process.version}`);
  console.log(`Platform: ${process.platform} (${process.arch})`);
  console.log(`CPUs:     ${process.env.NUMBER_OF_PROCESSORS || '1'} logical cores`);
  console.log('Warmup:   1,000 requests per scenario');
  console.log('Samples:  10,000 requests per scenario');
  console.log('Clock:    process.hrtime.bigint() (nanosecond resolution)\n');
  console.log('Running benchmark suite... Please wait.\n');

  const start = Date.now();
  const report = await runBenchmark({ iterations: 10000, warmup: 1000 });
  const totalDuration = ((Date.now() - start) / 1000).toFixed(2);

  console.log('--------------------------------------------------------------------------------');
  console.log('BENCHMARK RESULTS SUMMARY');
  console.log('--------------------------------------------------------------------------------\n');

  const tableRows = report.scenarios.map((s) => ({
    'Scenario': s.scenario,
    'Throughput (ops/s)': s.opsPerSec.toLocaleString(),
    'Mean (µs)': s.stats.meanUs.toFixed(2),
    'p50 (µs)': s.stats.p50Us.toFixed(2),
    'p95 (µs)': s.stats.p95Us.toFixed(2),
    'p99 (µs)': s.stats.p99Us.toFixed(2),
    'Added p50 (µs)': s.overheadP50Us > 0 ? `+${s.overheadP50Us.toFixed(2)} µs` : 'baseline'
  }));

  console.table(tableRows);

  console.log('\n--------------------------------------------------------------------------------');
  console.log('REALISTIC OVERHEAD ANALYSIS & FINDINGS');
  console.log('--------------------------------------------------------------------------------');
  console.log(`• Total benchmark execution time: ${totalDuration}s`);
  console.log(`• No-op middleware baseline p50 latency: ${report.scenarios[0].stats.p50Us} µs`);
  console.log(
    `• Fixed Window added latency:             +${report.scenarios[1].overheadP50Us} µs (${(report.scenarios[1].overheadP50Us / 1000).toFixed(4)} ms)`
  );
  console.log(
    `• Sliding Window added latency:           +${report.scenarios[2].overheadP50Us} µs (${(report.scenarios[2].overheadP50Us / 1000).toFixed(4)} ms)`
  );
  console.log(
    `• Token Bucket added latency:             +${report.scenarios[3].overheadP50Us} µs (${(report.scenarios[3].overheadP50Us / 1000).toFixed(4)} ms)`
  );
  console.log(
    `• Metrics Collection added latency:       +${(report.scenarios[4].stats.p50Us - report.scenarios[2].stats.p50Us).toFixed(2)} µs over Sliding Window`
  );
  console.log(
    `• Metrics + OTel mock-span scenario p50:  ${report.scenarios[5].stats.p50Us} µs`
  );
  console.log('\nTakeaway: The per-scenario latency and throughput above are the measured results for this run; performance varies with runtime and workload.');
  console.log('We measure and report real microseconds instead of making false "zero overhead" claims.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
