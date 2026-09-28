import type { Logger } from '@tessera/platform';
import { AppError } from '@tessera/platform';
import { problemDetailsSchema } from '@tessera/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

export type SessionStage = 'credential_setup' | 'mfa_pending' | 'active';

/**
 * Authentication requirement (docs/authentication.md §4).
 * - `public`: no session needed (a session, if present, is still resolved).
 * - `session`: a valid session in one of `stages` (default: `active`). `stepUp` additionally
 *   requires re-authentication within the last STEP_UP_WINDOW_MS.
 */
export type AuthRequirement =
  | { readonly kind: 'public' }
  | {
      readonly kind: 'session';
      readonly stages?: readonly SessionStage[];
      readonly stepUp?: boolean;
    };

export const STEP_UP_WINDOW_MS = 10 * 60_000;

export interface AuthenticatedSession {
  readonly id: string;
  readonly userId: string;
  readonly stage: SessionStage;
  readonly reauthenticatedAt: Date | null;
}

/** Resolves the session for a request. Implemented by the auth module and injected in app.ts. */
export interface SessionAuthenticator {
  authenticate(token: string): Promise<AuthenticatedSession | null>;
}

/** Name of the session cookie. `__Host-` forces Secure, Path=/ and no Domain (host-only). */
export const SESSION_COOKIE = '__Host-tsid';

export interface RouteContext<A extends AuthRequirement = AuthRequirement> {
  readonly requestId: string;
  readonly clientIp: string;
  readonly userAgent: string | undefined;
  readonly log: Logger;
  /** Present for `session` routes; for `public` routes, the caller's session if any. */
  readonly session: A extends { kind: 'session' }
    ? AuthenticatedSession
    : AuthenticatedSession | null;
  /** Applies an additional rate limit (e.g. per login identifier); throws RATE_LIMITED. */
  rateLimit(policy: RateLimitPolicy, subject: string): Promise<void>;
  setSessionCookie(token: string, expiresAt: Date): void;
  clearSessionCookie(): void;
}

/** Authorization policy. Deny-by-default: a policy must explicitly return true. */
export interface Policy {
  readonly name: string;
  allows(context: RouteContext): boolean | Promise<boolean>;
}

/** Policy for endpoints whose only requirement is the authenticated session itself. */
export const ownAccount: Policy = {
  name: 'own_account',
  allows: (context) => context.session !== null,
};

/** Policy for endpoints that are intentionally readable by anyone. */
export const publicAccess: Policy = { name: 'public', allows: () => true };

/**
 * Audit decision (docs/security.md §11). `records` routes write audit entries inside their own
 * transaction (modules/audit); the declaration lists the actions so reviewers can check them.
 * `none` routes must say why no record is needed.
 */
export type AuditRequirement =
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'records'; readonly actions: readonly string[] };

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

export interface RouteDefinition<
  S extends RouteSchema = RouteSchema,
  A extends AuthRequirement = AuthRequirement,
> {
  /** Stable identifier `<module>.<action>`; used in logs, metrics and the completeness test. */
  readonly id: string;
  readonly method: HttpMethod;
  readonly url: `/api/v1/${string}`;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: A;
  readonly authorize: Policy;
  readonly rateLimit: RateLimitPolicy;
  readonly audit: AuditRequirement;
  readonly schema: S;
  readonly successStatus: 200 | 201 | 202;
  /** Overrides the global request body limit (bytes) for this route only. */
  readonly bodyLimit?: number;
  // Method syntax (bivariant parameters) lets specific routes be collected as RouteDefinition[].
  handler(input: RouteInput<S>, context: RouteContext<A>): Promise<z.infer<S['response']>>;
}

/** Identity function that fixes the generic parameters so handlers are fully typed. */
export function defineRoute<S extends RouteSchema, const A extends AuthRequirement>(
  definition: RouteDefinition<S, A>,
): RouteDefinition<S, A> {
  return definition;
}

export interface RouteRegistrationDeps {
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly sessions: SessionAuthenticator;
}

/**
 * Per-IP flood guard applied to every route before any other work. Deliberately generous: many
 * users can share one address (carrier-grade NAT, offices, campuses), so per-IP limits must not
 * be the primary control for signed-in users — their route limits are per user.
 */
export const IP_FLOOD_GUARD: RateLimitPolicy = {
  name: 'ip.flood',
  limit: 1200,
  periodMs: 60_000,
  burst: 300,
  onStoreFailure: 'open',
};

declare module 'fastify' {
  interface FastifyContextConfig {
    routeId?: string;
  }
  interface FastifyRequest {
    authSession: AuthenticatedSession | null;
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
  const contextOf = (request: FastifyRequest, reply: FastifyReply): RouteContext => ({
    requestId: request.id,
    clientIp: request.ip,
    userAgent: request.headers['user-agent'],
    log: deps.logger.child({ reqId: request.id, routeId: route.id }),
    session: request.authSession,
    rateLimit: (policy, subject) => enforceLimit(deps.rateLimiter, policy, subject),
    setSessionCookie: (token, expiresAt) => {
      void reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expires: expiresAt,
      });
    },
    clearSessionCookie: () => {
      void reply.clearCookie(SESSION_COOKIE, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      });
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: route.method,
    url: route.url,
    config: { routeId: route.id },
    ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
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
    // Rate limiting and authentication run before body parsing and validation, so malformed or
    // oversized requests still count, and unauthenticated callers cost at most a cookie lookup.
    // The route limit applies per user once authenticated, otherwise per client address.
    onRequest: async (request: FastifyRequest) => {
      const ipSubject = rateLimitSubject(request.ip);
      await enforceLimit(deps.rateLimiter, IP_FLOOD_GUARD, ipSubject);
      request.authSession = await authenticate(request, route.auth, deps.sessions);
      const subject =
        route.auth.kind === 'session' && request.authSession !== null
          ? `user:${request.authSession.userId}`
          : ipSubject;
      await enforceLimit(deps.rateLimiter, route.rateLimit, subject);
    },
    // Authorization runs after schema validation, with typed input available to later policies.
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(await route.authorize.allows(contextOf(request, reply)))) {
        throw new AppError('FORBIDDEN');
      }
    },
    handler: async (request, reply) => {
      const result = await route.handler(
        { params: request.params, query: request.query, body: request.body },
        contextOf(request, reply),
      );
      return reply.code(route.successStatus).send(result);
    },
  });
}

async function enforceLimit(
  limiter: RateLimiter,
  policy: RateLimitPolicy,
  subject: string,
): Promise<void> {
  const decision = await limiter.consume(policy, subject);
  if (!decision.allowed) {
    throw new AppError('RATE_LIMITED', {
      retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
    });
  }
}

async function authenticate(
  request: FastifyRequest,
  requirement: AuthRequirement,
  sessions: SessionAuthenticator,
): Promise<AuthenticatedSession | null> {
  const token = request.cookies[SESSION_COOKIE];
  const session =
    token === undefined || token.length === 0 || token.length > 128
      ? null
      : await sessions.authenticate(token);
  if (requirement.kind === 'public') return session;

  if (session === null) throw new AppError('UNAUTHENTICATED');
  const stages = requirement.stages ?? ['active'];
  if (!stages.includes(session.stage)) throw new AppError('FORBIDDEN');
  if (requirement.stepUp === true) {
    const recent =
      session.reauthenticatedAt !== null &&
      Date.now() - session.reauthenticatedAt.getTime() <= STEP_UP_WINDOW_MS;
    if (!recent) throw new AppError('STEP_UP_REQUIRED');
  }
  return session;
}
