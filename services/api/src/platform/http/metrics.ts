import { Counter, Histogram, LATENCY_BUCKETS, type Registry } from '@tessera/platform';
import type { FastifyInstance } from 'fastify';

/**
 * Request rate, errors and latency per route (docs/observability.md §2, the SLIs behind the API
 * and message-submit SLOs). The route label is the route id from its definition, or `unmatched`
 * (404s for unknown paths), so its cardinality is the size of the route catalogue.
 */
export function installHttpMetrics(app: FastifyInstance, registry: Registry): void {
  const requests = new Counter({
    name: 'tessera_http_requests_total',
    help: 'HTTP requests by route, method and status class.',
    labelNames: ['route', 'method', 'status_class'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'tessera_http_request_duration_seconds',
    help: 'HTTP request duration by route and method.',
    labelNames: ['route', 'method'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.config.routeId ?? 'unmatched';
    const method = request.method;
    requests.inc({ route, method, status_class: `${Math.floor(reply.statusCode / 100)}xx` });
    duration.observe({ route, method }, reply.elapsedTime / 1000);
  });
}
