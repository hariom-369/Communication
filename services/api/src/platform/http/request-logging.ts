import type { Logger } from '@tessera/platform';
import type { FastifyInstance } from 'fastify';

/**
 * One structured line per request with allow-listed fields only: never URLs with query strings,
 * headers, bodies or IP addresses (IPs belong to the security log pipeline, docs/observability.md).
 */
export function installRequestLogging(app: FastifyInstance, logger: Logger): void {
  app.addHook('onResponse', async (request, reply) => {
    logger.info('http.request', {
      reqId: request.id,
      routeId: request.routeOptions.config.routeId ?? null,
      method: request.method,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });
}
