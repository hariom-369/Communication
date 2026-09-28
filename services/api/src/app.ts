import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import type { Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { CSRF_HEADER, installCsrfProtection } from './platform/http/csrf.js';
import { installErrorHandling } from './platform/http/errors.js';
import { installRequestLogging } from './platform/http/request-logging.js';
import {
  registerRoutes,
  type RouteDefinition,
  type SessionAuthenticator,
} from './platform/http/routes.js';
import { installSecurityHeaders } from './platform/http/security-headers.js';
import type { RateLimiter } from './platform/rate-limit.js';

export interface AppOptions {
  readonly logger: Logger;
  readonly rateLimiter: RateLimiter;
  readonly allowedOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly bodyLimitBytes: number;
  readonly hsts: boolean;
  readonly routes: readonly RouteDefinition[];
  readonly sessions: SessionAuthenticator;
}

/** Builds the HTTP application. No I/O happens here; dependencies are injected. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => newId(),
    requestIdHeader: false, // never trust client-supplied request IDs
    // Trust exactly N reverse-proxy hops for X-Forwarded-For (0 = use the socket address).
    trustProxy:
      options.trustProxyHops === 0 ? false : (_address, hop) => hop < options.trustProxyHops,
    bodyLimit: options.bodyLimitBytes,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  installErrorHandling(app, options.logger);
  installSecurityHeaders(app, { hsts: options.hsts });
  installRequestLogging(app, options.logger);

  await app.register(cors, {
    origin: [...options.allowedOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', CSRF_HEADER, 'idempotency-key'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
    strictPreflight: true,
  });
  installCsrfProtection(app, { allowedOrigins: options.allowedOrigins });
  // Parses cookies only; the session cookie is set with explicit attributes in routes.ts.
  await app.register(cookie, { hook: 'onRequest' });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Tessera API', version: 'v1' },
    },
    transform: jsonSchemaTransform,
  });

  registerRoutes(app, options.routes, {
    rateLimiter: options.rateLimiter,
    logger: options.logger,
    sessions: options.sessions,
  });

  await app.ready();
  return app;
}
