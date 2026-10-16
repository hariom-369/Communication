import { createMetricsRegistry } from '@tessera/platform';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../../test/helpers.js';

describe('HTTP metrics', () => {
  it('count requests per route id and status class, never per raw path', async () => {
    const registry = createMetricsRegistry('api');
    const { app } = await buildTestApp({ metrics: registry });
    await app.inject({ url: '/api/v1/meta/version' });
    await app.inject({ url: '/api/v1/meta/version' });
    await app.inject({ url: '/api/v1/no/such/route/0b9e2c4a' });
    const text = await registry.metrics();
    expect(text).toContain(
      'tessera_http_requests_total{route="meta.version",method="GET",status_class="2xx",service="api"} 2',
    );
    expect(text).toContain(
      'tessera_http_requests_total{route="unmatched",method="GET",status_class="4xx",service="api"} 1',
    );
    const histogram = await registry
      .getSingleMetric('tessera_http_request_duration_seconds')
      ?.get();
    const count = histogram?.values.find(
      (value) =>
        // Histogram values carry their series name (prom-client's types omit it).
        (value as { metricName?: string }).metricName ===
          'tessera_http_request_duration_seconds_count' && value.labels['route'] === 'meta.version',
    );
    expect(count?.value).toBe(2);
    expect(text).not.toContain('0b9e2c4a');
    await app.close();
  });
});
