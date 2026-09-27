import type { Logger } from '@tessera/platform';
import { AppError } from '@tessera/platform';
import { problemDetailsSchema } from '@tessera/validation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';

import { rateLimitSubject, type RateLimiter, type RateLimitPolicy } from '../rate-limit.js';

/**
 * Every API endpoint is declared through `defineRoute`. The type makes the per-endpoint contract
 * from docs/architecture.md §5 mandatory: authentication, authorization, validation schemas,
 * rate limit, audit decision, and error contract (problem+json via the central error handler).
 * `src/platform/http/routes-completeness.test.ts` additionally checks that every registered route
 * is exercised by at least one test.
 */

/**
 * Authentication requirement. Phase 1 only has public endpoints; session- and device-scoped
 * requirements arrive with the auth module in Phase 2 (docs/authentication.md).
 */
export interface AuthRequirement {
  readonly kind: 'public';
}

export interface RouteContext {
  readonly requestId: string;
  readonly clientIp: string;
  readonly log: Logger;
}

/** Authorization policy. Deny-by-default: a policy must explicitly return true. */
export interface Policy {
  readonly name: string;
  allows(context: RouteContext): boolean | Promise<boolean>;
}

/** Policy for endpoints that are intentionally readable by anyone. */
export const publicAccess: Policy = { name: 'public', allows: () => true };

/**
 * Audit decision. Phase 1 endpoints do not mutate state, so they declare why no audit record is
 * written. Audited actions are added together with the audit log in Phase 2 (docs/security.md §11).
 */
export interface AuditRequirement {
  readonly kind: 'none';
  readonly reason: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSchema {
  readonly params?: z.ZodType;
  readonly querystring?: z.ZodType;
  readonly body?: z.ZodType;
  /** Success response DTO. Serialisation strips unknown keys, so internals cannot leak. */
  readonly response: z.ZodType;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface RouteInput<S extends RouteSchema> {
  readonly params: Infer<S['params']>;
  readonly query: Infer<S['querystring']>;
  readonly body: Infer<S['body']>;
}

export interface RouteDefinition<S extends RouteSchema = RouteSchema> {
  /** Stable identifier `<module>.<action>`; used in logs, metrics and the completeness test. */
  readonly id: string;
  readonly method: HttpMethod;
  readonly url: `/api/v1/${string}`;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: AuthRequirement;
  readonly authorize: Policy;
  readonly rateLimit: RateLimitPolicy;
  readonly audit: AuditRequirement;
  readonly schema: S;
  readonly successStatus: 200 | 201 | 202;
  // Method syntax (bivariant parameters) lets specific routes be collected as RouteDefinition[].
  handler(input: RouteInput<S>, context: RouteContext): Promise<z.infer<S['response']>>;
}

/** Identity function that fixes the generic parameter so handlers are fully typed. */
export function defineRoute<S extends RouteSchema>(
  definition: RouteDefinition<S>,
): RouteDefinition<S> {
  return definition;
}

export interface RouteRegistrationDeps {
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    routeId?: string;
  }
}

/** Every error response is RFC 9457 problem details (see ./errors.ts). */
const problemResponse = {
  description: 'Error (RFC 9457 problem details)',
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
};

export function registerRoutes(
  app: FastifyInstance,
  routes: readonly RouteDefinition[],
  deps: RouteRegistrationDeps,
): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.id)) throw new Error(`Duplicate route id ${route.id}`);
    seen.add(route.id);
    registerRoute(app, route, deps);
  }
}

function registerRoute(
  app: FastifyInstance,
  route: RouteDefinition,
  deps: RouteRegistrationDeps,
): void {
  const contextOf = (request: FastifyRequest): RouteContext => ({
    requestId: request.id,
    clientIp: request.ip,
    log: deps.logger.child({ reqId: request.id, routeId: route.id }),
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: route.method,
    url: route.url,
    config: { routeId: route.id },
    schema: {
      summary: route.summary,
      tags: [...route.tags],
      operationId: route.id,
      ...(route.schema.params === undefined ? {} : { params: route.schema.params }),
      ...(route.schema.querystring === undefined ? {} : { querystring: route.schema.querystring }),
      ...(route.schema.body === undefined ? {} : { body: route.schema.body }),
      response: {
        [route.successStatus]: route.schema.response,
        '4XX': problemResponse,
        '5XX': problemResponse,
      },
    },
    // Rate limiting runs first (before body parsing and validation) so that malformed or
    // oversized requests still count against the caller.
    onRequest: async (request: FastifyRequest) => {
      const decision = await deps.rateLimiter.consume(
        route.rateLimit,
        rateLimitSubject(request.ip),
      );
      if (!decision.allowed) {
        throw new AppError('RATE_LIMITED', {
          retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        });
      }
    },
    // Authorization runs after schema validation, with typed input available to later policies.
    preHandler: async (request: FastifyRequest) => {
      if (!(await route.authorize.allows(contextOf(request)))) throw new AppError('FORBIDDEN');
    },
    handler: async (request, reply) => {
      const result = await route.handler(
        { params: request.params, query: request.query, body: request.body },
        contextOf(request),
      );
      return reply.code(route.successStatus).send(result);
    },
  });
}
