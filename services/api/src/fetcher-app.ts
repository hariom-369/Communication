import { createHash, timingSafeEqual } from 'node:crypto';

import { Counter, type Logger, type Registry } from '@tessera/platform';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { fetchLinkPreview, SafeFetchError, type LinkPreview } from './platform/safe-fetch/index.js';
import { FETCHER_PREVIEW_PATH, type FetcherResponse } from './platform/safe-fetch/remote.js';

/**
 * The isolated link-preview fetcher (docs/security.md §6, security review F-05): one internal
 * route that runs the SSRF-hardened fetcher for the API. It holds no database or Valkey
 * connection and no secret except its own bearer token, so code execution through a parser bug
 * here reaches neither user data nor keys; its egress policy (infra/k8s) allows public addresses
 * on 443 and DNS only, a second layer under the fetcher's own address checks.
 */

export interface FetcherAppOptions {
  readonly logger: Logger;
  /** Shared with the API (`LINK_PREVIEW_FETCHER_TOKEN`). */
  readonly token: string;
  /** Requests answered at once; more get 503 so a flood cannot queue unbounded work. */
  readonly maxConcurrent: number;
  readonly metrics?: Registry;
  /** Replaceable in tests. */
  readonly fetchPreview?: (url: string) => Promise<LinkPreview>;
}

const bodySchema = z.strictObject({ url: z.string().max(2048) });

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export async function buildFetcherApp(options: FetcherAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 4096,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
  });
  const expected = digest(`Bearer ${options.token}`);
  const fetchPreview = options.fetchPreview ?? ((url: string) => fetchLinkPreview(url));
  const results =
    options.metrics === undefined
      ? undefined
      : new Counter({
          name: 'tessera_fetcher_requests_total',
          help: 'Link-preview fetches by result (ok, a refusal reason, busy, unauthorized).',
          labelNames: ['result'] as const,
          registers: [options.metrics],
        });
  let inFlight = 0;

  app.post(FETCHER_PREVIEW_PATH, async (request, reply) => {
    const presented = request.headers.authorization;
    if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
      results?.inc({ result: 'unauthorized' });
      options.logger.warn('fetcher.unauthorized', { ok: false });
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = bodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    if (inFlight >= options.maxConcurrent) {
      results?.inc({ result: 'busy' });
      return reply.code(503).header('retry-after', '1').send({ error: 'busy' });
    }
    inFlight += 1;
    try {
      const preview = await fetchPreview(body.data.url);
      results?.inc({ result: 'ok' });
      return { preview } satisfies FetcherResponse;
    } catch (error) {
      if (!(error instanceof SafeFetchError)) throw error;
      results?.inc({ result: error.reason });
      return { preview: null, reason: error.reason } satisfies FetcherResponse;
    } finally {
      inFlight -= 1;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    // Fastify's own client errors (oversized or unparsable body) keep their status.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500)
      return reply.code(status).send({ error: 'invalid_request' });
    options.logger.error('fetcher.unexpected_error', options.logger.errorFields(error));
    return reply.code(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));

  await app.ready();
  return app;
}
