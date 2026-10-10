import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import {
  registerAdminRoutes,
  type AdminAuditSink,
  type AdminAuthenticator,
  type AdminRouteDefinition,
} from './platform/http/admin-routes.js';
import { CSRF_HEADER, installCsrfProtection } from './platform/http/csrf.js';
import { installErrorHandling } from './platform/http/errors.js';
import { installRequestLogging } from './platform/http/request-logging.js';
import { installSecurityHeaders } from './platform/http/security-headers.js';
import type { RateLimiter } from './platform/rate-limit.js';

export interface AdminAppOptions {
  readonly logger: Logger;
  readonly rateLimiter: RateLimiter;
  /** The admin SPA's origin(s) only. */
  readonly allowedOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly hsts: boolean;
  readonly routes: readonly AdminRouteDefinition[];
  readonly sessions: AdminAuthenticator;
  readonly audit: AdminAuditSink;
}

/**
 * The admin HTTP application (ADR-050): same hardening as the user API (security headers, CSRF,
 * problem+json errors, no client request ids, strict CORS) but only admin routes, the admin
 * origin and the admin session.
 */
export async function buildAdminApp(options: AdminAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => newId(),
    requestIdHeader: false,
    trustProxy:
      options.trustProxyHops === 0 ? false : (_address, hop) => hop < options.trustProxyHops,
    bodyLimit: 64 * 1024,
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
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', CSRF_HEADER],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
    strictPreflight: true,
  });
  installCsrfProtection(app, { allowedOrigins: options.allowedOrigins });
  await app.register(cookie, { hook: 'onRequest' });
  registerAdminRoutes(app, options.routes, {
    rateLimiter: options.rateLimiter,
    logger: options.logger,
    sessions: options.sessions,
    audit: options.audit,
  });
  await app.ready();
  return app;
}
