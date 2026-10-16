import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export { Counter, Gauge, Histogram, Registry };

/**
 * Prometheus metrics (docs/observability.md §2). Each service owns one registry, exposed on its
 * internal health port at `/metrics` and never on a public port. Labels are bounded by
 * construction: route ids, job names, enum-like results — never user ids, URLs or addresses.
 */
export function createMetricsRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: 'tessera_' });
  return registry;
}

/** Seconds-scale buckets for request and job latencies (5 ms … 10 s). */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.4, 1, 2.5, 5, 10];

/** Outcomes of a periodic job run. */
export type JobResult = 'ok' | 'failed' | 'skipped';

export interface JobMetrics {
  observe(job: string, result: JobResult, seconds: number): void;
}

/** Run counts, durations and the last success time of periodic jobs. */
export function jobMetrics(registry: Registry): JobMetrics {
  const runs = new Counter({
    name: 'tessera_job_runs_total',
    help: 'Periodic job runs by result (skipped: another instance held the lock).',
    labelNames: ['job', 'result'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'tessera_job_duration_seconds',
    help: 'Duration of periodic job runs that held the lock.',
    labelNames: ['job'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });
  const lastSuccess = new Gauge({
    name: 'tessera_job_last_success_timestamp_seconds',
    help: 'Unix time of the last successful run of a periodic job on this instance.',
    labelNames: ['job'] as const,
    registers: [registry],
  });
  return {
    observe(job, result, seconds) {
      runs.inc({ job, result });
      if (result === 'skipped') return;
      duration.observe({ job }, seconds);
      if (result === 'ok') lastSuccess.set({ job }, Date.now() / 1000);
    },
  };
}
