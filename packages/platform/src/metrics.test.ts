import { describe, expect, it } from 'vitest';

import { createHealthServer } from './health.js';
import { createLogger } from './logger.js';
import { createMetricsRegistry, jobMetrics } from './metrics.js';
import { MemoryDestination } from './testing/memory-destination.js';

const logger = createLogger({
  service: 'test',
  level: 'fatal',
  errorDetails: false,
  destination: new MemoryDestination(),
});

describe('metrics', () => {
  it('are served on the health server in the Prometheus text format', async () => {
    const registry = createMetricsRegistry('api');
    jobMetrics(registry).observe('mailbox_sweeper', 'ok', 0.2);
    const health = createHealthServer({
      checks: [],
      logger,
      checkTimeoutMs: 50,
      state: { isStarted: () => true, isDraining: () => false },
      metrics: registry,
    });
    const response = await health.inject('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain(
      'tessera_job_runs_total{job="mailbox_sweeper",result="ok",service="api"} 1',
    );
    expect(response.body).toContain('tessera_process_cpu_seconds_total');
    expect(response.body).toMatch(
      /tessera_job_last_success_timestamp_seconds\{job="mailbox_sweeper",service="api"\} \d+/,
    );
  });

  it('are absent unless a registry is given', async () => {
    const health = createHealthServer({
      checks: [],
      logger,
      checkTimeoutMs: 50,
      state: { isStarted: () => true, isDraining: () => false },
    });
    expect((await health.inject('/metrics')).statusCode).toBe(404);
  });

  it('count skipped job runs without recording a duration or a success', async () => {
    const registry = createMetricsRegistry('api');
    jobMetrics(registry).observe('channel_scheduler', 'skipped', 0);
    const text = await registry.metrics();
    expect(text).toContain('tessera_job_runs_total{job="channel_scheduler",result="skipped"');
    expect(text).not.toContain(
      'tessera_job_last_success_timestamp_seconds{job="channel_scheduler"',
    );
    expect(text).not.toContain('tessera_job_duration_seconds_count{job="channel_scheduler"');
  });
});
