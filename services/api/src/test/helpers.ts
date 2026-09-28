import { createLogger, type Logger } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { buildApp, type AppOptions } from '../app.js';
import { metaRoutes } from '../modules/meta/index.js';
import { defineRoute, publicAccess, type RouteDefinition } from '../platform/http/routes.js';
import { InProcessRateLimiter, type RateLimitPolicy } from '../platform/rate-limit.js';

export const TEST_ORIGIN = 'https://app.tessera.test';

export const generousLimit: RateLimitPolicy = {
  name: 'test.generous',
  limit: 10_000,
  periodMs: 1_000,
  burst: 10_000,
  onStoreFailure: 'open',
};

/** Routes that exist only in tests, to exercise pipeline behaviour for state-changing requests. */
export const testRoutes: RouteDefinition[] = [
  defineRoute({
    id: 'test.echo',
    method: 'POST',
    url: '/api/v1/test/echo',
    summary: 'Echo',
    tags: ['test'],
    auth: { kind: 'public' },
    authorize: publicAccess,
    rateLimit: generousLimit,
    audit: { kind: 'none', reason: 'test' },
    schema: {
      body: z.strictObject({ text: z.string().max(100) }),
      response: z.object({ text: z.string() }),
    },
    successStatus: 201,
    handler: (input) =>
      // The extra property must be stripped by response serialisation (DTO enforcement).
      Promise.resolve({ text: input.body.text, internalSecret: 'db-row-field' }),
  }),
  defineRoute({
    id: 'test.boom',
    method: 'GET',
    url: '/api/v1/test/boom',
    summary: 'Throws an unexpected error',
    tags: ['test'],
    auth: { kind: 'public' },
    authorize: publicAccess,
    rateLimit: generousLimit,
    audit: { kind: 'none', reason: 'test' },
    schema: { response: z.object({}) },
    successStatus: 200,
    handler: () => {
      throw new Error('connection to 10.1.2.3:5432 failed for user tessera_prod password=CANARY');
    },
  }),
  defineRoute({
    id: 'test.denied',
    method: 'GET',
    url: '/api/v1/test/denied',
    summary: 'Always denied',
    tags: ['test'],
    auth: { kind: 'public' },
    authorize: { name: 'deny', allows: () => false },
    rateLimit: generousLimit,
    audit: { kind: 'none', reason: 'test' },
    schema: { response: z.object({}) },
    successStatus: 200,
    handler: () => Promise.resolve({}),
  }),
  defineRoute({
    id: 'test.strict',
    method: 'GET',
    url: '/api/v1/test/strict',
    summary: 'Tight rate limit',
    tags: ['test'],
    auth: { kind: 'public' },
    authorize: publicAccess,
    rateLimit: {
      name: 'test.strict',
      limit: 2,
      periodMs: 60_000,
      burst: 2,
      onStoreFailure: 'open',
    },
    audit: { kind: 'none', reason: 'test' },
    schema: { querystring: z.strictObject({}), response: z.object({}) },
    successStatus: 200,
    handler: () => Promise.resolve({}),
  }),
];

export interface TestApp {
  app: FastifyInstance;
  logs: MemoryDestination;
  logger: Logger;
}

export async function buildTestApp(overrides: Partial<AppOptions> = {}): Promise<TestApp> {
  const logs = new MemoryDestination();
  const logger = createLogger({
    service: 'api-test',
    level: 'debug',
    errorDetails: false,
    destination: logs,
  });
  const app = await buildApp({
    logger,
    rateLimiter: new InProcessRateLimiter(),
    allowedOrigins: [TEST_ORIGIN],
    trustProxyHops: 0,
    bodyLimitBytes: 1024,
    hsts: true,
    routes: [...metaRoutes({ build: { version: '1.2.3', commit: 'abc123' } }), ...testRoutes],
    sessions: { authenticate: () => Promise.resolve(null) },
    ...overrides,
  });
  return { app, logs, logger };
}

/** Headers a legitimate same-site browser request from our web app sends. */
export const sameSiteHeaders = {
  origin: TEST_ORIGIN,
  'sec-fetch-site': 'same-site',
  'x-tessera-csrf': '1',
  'content-type': 'application/json',
} as const;
