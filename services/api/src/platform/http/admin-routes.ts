import { AppError, type Logger } from '@tessera/platform';
import { problemDetailsSchema } from '@tessera/validation';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';

import type { AuditDetails, AuditEntry } from '../../modules/audit/index.js';
import { rateLimitSubject, type RateLimiter, type RateLimitPolicy } from '../rate-limit.js';

/**
 * The admin console's request pipeline (docs/admin.md, ADR-050). Separate from the user API's:
 * its own process and port, its own origin allow-list, its own session cookie, and a stricter
 * contract — every route names the capability it needs, and **every call is audited**, refusals
 * included, before the response is sent.
 */

export type AdminStage = 'key' | 'active';

export interface AdminPrincipal {
  readonly sessionId: string;
  readonly adminId: string;
  readonly stage: AdminStage;
  readonly roles: readonly string[];
  readonly capabilities: ReadonlySet<string>;
  readonly reauthenticatedAt: Date | null;
}

export interface AdminAuthenticator {
  authenticate(token: string): Promise<AdminPrincipal | null>;
}

export interface AdminAuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** `public`: before sign-in (identity provider round trip). */
export type AdminAuthRequirement =
  | { readonly kind: 'public' }
  | {
      readonly kind: 'session';
      /** Default: `active` (identity provider and security key both done). */
      readonly stages?: readonly AdminStage[];
      /** Required capability (docs/admin.md §2); omit only for routes every admin may use. */
      readonly capability?: string;
      /** Requires a security-key confirmation within ADMIN_STEP_UP_MS. */
      readonly stepUp?: boolean;
    };

export const ADMIN_STEP_UP_MS = 5 * 60_000;
export const ADMIN_SESSION_COOKIE = '__Host-tadm';
export const ADMIN_FLOW_COOKIE = '__Host-tadm-flow';

export interface AdminRouteContext<A extends AdminAuthRequirement = AdminAuthRequirement> {
  readonly requestId: string;
  readonly clientIp: string;
  readonly userAgent: string | undefined;
  readonly log: Logger;
  readonly admin: A extends { kind: 'session' } ? AdminPrincipal : AdminPrincipal | null;
  rateLimit(policy: RateLimitPolicy, subject: string): Promise<void>;
  cookie(name: string): string | undefined;
  setCookie(name: string, value: string, expiresAt: Date): void;
  clearCookie(name: string): void;
  /** What the audit entry for this call is about. */
  auditTarget(kind: string, id: string): void;
  auditDetail(key: string, value: string | number | boolean | null): void;
}

interface AdminRouteSchema {
  readonly params?: z.ZodType;
  readonly querystring?: z.ZodType;
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface AdminRouteDefinition<
  S extends AdminRouteSchema = AdminRouteSchema,
  A extends AdminAuthRequirement = AdminAuthRequirement,
> {
  /** Stable id `admin.<action>`: also the action recorded in the audit log. */
  readonly id: `admin.${string}`;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: `/admin/v1/${string}`;
  readonly summary: string;
  readonly auth: A;
  readonly rateLimit: RateLimitPolicy;
  readonly schema: S;
  readonly successStatus: 200 | 201;
  handler(
    input: {
      readonly params: Infer<S['params']>;
      readonly query: Infer<S['querystring']>;
      readonly body: Infer<S['body']>;
    },
    context: AdminRouteContext<A>,
  ): Promise<z.infer<S['response']>>;
}

export function defineAdminRoute<S extends AdminRouteSchema, const A extends AdminAuthRequirement>(
  definition: AdminRouteDefinition<S, A>,
): AdminRouteDefinition<S, A> {
  return definition;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminPrincipal: AdminPrincipal | null;
    adminAudit: {
      targetKind?: string;
      targetId?: string;
      details: Record<string, string | number | boolean | null>;
    } | null;
  }
}

const problemResponse = {
  description: 'Error (RFC 9457 problem details)',
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
};

export interface AdminRouteDeps {
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly sessions: AdminAuthenticator;
  readonly audit: AdminAuditSink;
}

const ADMIN_FLOOD_GUARD: RateLimitPolicy = {
  name: 'admin.flood',
  limit: 600,
  periodMs: 60_000,
  burst: 120,
  onStoreFailure: 'closed',
};

export function registerAdminRoutes(
  app: FastifyInstance,
  routes: readonly AdminRouteDefinition[],
  deps: AdminRouteDeps,
): void {
  const seen = new Set<string>();
  app.decorateRequest('adminPrincipal', null);
  app.decorateRequest('adminAudit', null);
  for (const route of routes) {
    if (seen.has(route.id)) throw new Error(`Duplicate admin route id ${route.id}`);
    seen.add(route.id);
    registerAdminRoute(app, route, deps);
  }
  // Refusals and failures are audited too (successes are audited before the response).
  app.addHook('onError', async (request: FastifyRequest, _reply, error: FastifyError) => {
    const routeId = request.routeOptions.config.routeId;
    if (!routeId?.startsWith('admin.')) return;
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    await auditCall(deps, request, routeId, code).catch((auditError: unknown) => {
      deps.logger.error('admin.audit_failed', deps.logger.errorFields(auditError));
    });
  });
}

async function auditCall(
  deps: AdminRouteDeps,
  request: FastifyRequest,
  routeId: string,
  outcome: string,
): Promise<void> {
  const principal = request.adminPrincipal;
  const extra = request.adminAudit;
  const details: AuditDetails = {
    outcome,
    roles: principal === null ? '' : [...principal.roles].sort().join(','),
    ip: rateLimitSubject(request.ip),
    ...(extra?.details ?? {}),
  };
  await deps.audit.record({
    actorKind: 'admin',
    actorId: principal?.adminId ?? null,
    action: routeId,
    ...(extra?.targetKind === undefined ? {} : { targetKind: extra.targetKind }),
    ...(extra?.targetId === undefined ? {} : { targetId: extra.targetId }),
    requestId: request.id,
    details,
  });
}

function registerAdminRoute(
  app: FastifyInstance,
  route: AdminRouteDefinition,
  deps: AdminRouteDeps,
): void {
  const contextOf = (request: FastifyRequest, reply: FastifyReply): AdminRouteContext => ({
    requestId: request.id,
    clientIp: request.ip,
    userAgent: request.headers['user-agent'],
    log: deps.logger.child({ reqId: request.id, routeId: route.id }),
    admin: request.adminPrincipal,
    rateLimit: (policy, subject) => enforceLimit(deps.rateLimiter, policy, subject),
    cookie: (name) => request.cookies[name],
    setCookie: (name, value, expiresAt) => {
      void reply.setCookie(name, value, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        expires: expiresAt,
      });
    },
    clearCookie: (name) => {
      void reply.clearCookie(name, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
    },
    auditTarget: (kind, id) => {
      request.adminAudit ??= { details: {} };
      request.adminAudit.targetKind = kind;
      request.adminAudit.targetId = id;
    },
    auditDetail: (key, value) => {
      request.adminAudit ??= { details: {} };
      request.adminAudit.details[key] = value;
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: route.method,
    url: route.url,
    config: { routeId: route.id },
    schema: {
      summary: route.summary,
      tags: ['admin'],
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
    onRequest: async (request: FastifyRequest) => {
      const ipSubject = rateLimitSubject(request.ip);
      await enforceLimit(deps.rateLimiter, ADMIN_FLOOD_GUARD, ipSubject);
      // Who is calling is known before anything is refused, so refusals are attributed too.
      request.adminPrincipal = await principalOf(request, deps.sessions);
      requireStage(route.auth, request.adminPrincipal);
      await enforceLimit(
        deps.rateLimiter,
        route.rateLimit,
        request.adminPrincipal === null ? ipSubject : `admin:${request.adminPrincipal.adminId}`,
      );
      // Authorization comes before the body is even parsed: a role without the capability
      // learns nothing about the route's input.
      const denied = authorizationError(route.auth, request.adminPrincipal);
      if (denied !== undefined) throw denied;
    },
    handler: async (request, reply) => {
      const result = await route.handler(
        { params: request.params, query: request.query, body: request.body },
        contextOf(request, reply),
      );
      // The audit entry is written before the response: no audit, no answer.
      await auditCall(deps, request, route.id, 'ok');
      return reply.code(route.successStatus).send(result);
    },
  });
}

/** Deny by default: a route that names a capability needs it from a current role. */
function authorizationError(
  requirement: AdminAuthRequirement,
  principal: AdminPrincipal | null,
): AppError | undefined {
  if (requirement.kind !== 'session') return undefined;
  if (principal === null) return new AppError('UNAUTHENTICATED');
  if (requirement.capability !== undefined && !principal.capabilities.has(requirement.capability))
    return new AppError('FORBIDDEN');
  if (requirement.stepUp === true) {
    const recent =
      principal.reauthenticatedAt !== null &&
      Date.now() - principal.reauthenticatedAt.getTime() <= ADMIN_STEP_UP_MS;
    if (!recent) return new AppError('STEP_UP_REQUIRED');
  }
  return undefined;
}

async function enforceLimit(
  limiter: RateLimiter,
  policy: RateLimitPolicy,
  subject: string,
): Promise<void> {
  const decision = await limiter.consume(policy, subject);
  if (!decision.allowed)
    throw new AppError('RATE_LIMITED', {
      retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
    });
}

async function principalOf(
  request: FastifyRequest,
  sessions: AdminAuthenticator,
): Promise<AdminPrincipal | null> {
  const token = request.cookies[ADMIN_SESSION_COOKIE];
  return token === undefined || token.length === 0 || token.length > 128
    ? null
    : sessions.authenticate(token);
}

function requireStage(requirement: AdminAuthRequirement, principal: AdminPrincipal | null): void {
  if (requirement.kind === 'public') return;
  if (principal === null) throw new AppError('UNAUTHENTICATED');
  const stages = requirement.stages ?? ['active'];
  if (!stages.includes(principal.stage)) throw new AppError('FORBIDDEN');
}
