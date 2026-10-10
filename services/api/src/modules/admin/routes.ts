import { AppError } from '@tessera/platform';
import {
  adminDashboardSchema,
  adminFlagListSchema,
  adminKeyOptionsSchema,
  adminKeyVerifySchema,
  adminListSchema,
  adminMeSchema,
  adminOidcCallbackSchema,
  adminOidcStartSchema,
  adminParamsSchema,
  adminSessionStateSchema,
  adminUserDetailSchema,
  adminUserLookupSchema,
  adminUserParamsSchema,
  adminUserSummarySchema,
  approvalListSchema,
  approvalParamsSchema,
  approvalQuerySchema,
  approvalSchema,
  auditPageSchema,
  auditQuerySchema,
  createTicketSchema,
  decideApprovalSchema,
  healthSchema,
  okResponseSchema,
  purposeBodySchema,
  purposeQuerySchema,
  requestApprovalSchema,
  revokeStaffRoleSchema,
  revokeUserSessionsSchema,
  securityHotspotsSchema,
  signupAnalyticsSchema,
  staffRoleListSchema,
  ticketListSchema,
  ticketParamsSchema,
  ticketSchema,
  type AdminRole,
} from '@tessera/validation';
import { z } from 'zod';

import {
  ADMIN_FLOW_COOKIE,
  ADMIN_SESSION_COOKIE,
  ADMIN_STEP_UP_MS,
  defineAdminRoute,
  type AdminPrincipal,
  type AdminRouteDefinition,
} from '../../platform/http/admin-routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { AdminDirectory } from './admins.js';
import type { Approvals, ApprovalRow } from './approvals.js';
import type { AdminAuthService } from './auth.js';
import type { Capability } from './rbac.js';
import type { AdminService } from './service.js';
import type { AdminSessions } from './sessions.js';

export interface AdminModuleDeps {
  readonly auth: AdminAuthService;
  readonly admin: AdminService;
  readonly approvals: Approvals;
  readonly directory: AdminDirectory;
  readonly sessions: AdminSessions;
}

const policy = (name: string, limit: number, periodMs: number, burst: number): RateLimitPolicy => ({
  name: `admin.${name}`,
  limit,
  periodMs,
  burst,
  onStoreFailure: 'closed',
});
const limits = {
  // The identity provider authenticates; these steps check no guessable secret. Per address
  // before the session exists (staff behind one office NAT share it), per admin after.
  signIn: policy('sign_in', 60, 600_000, 20),
  read: policy('read', 600, 60_000, 120),
  write: policy('write', 300, 3_600_000, 60),
  lookup: policy('lookup', 120, 3_600_000, 30),
};

const ok = { ok: true as const };
const session = (capability: Capability, stepUp = false) =>
  ({ kind: 'session', capability, ...(stepUp ? { stepUp: true } : {}) }) as const;
const roles = (principal: AdminPrincipal) => principal.roles as AdminRole[];
const FLOW_TTL_MS = 10 * 60_000;

function approvalView(row: ApprovalRow) {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    decisionNote: row.decision_note,
  };
}

export function adminRoutes(deps: AdminModuleDeps): AdminRouteDefinition[] {
  const { auth, admin, approvals, directory, sessions } = deps;
  return [
    // ---- sign-in: identity provider, then security key ----------------------------------------
    defineAdminRoute({
      id: 'admin.oidc_start',
      method: 'POST',
      url: '/admin/v1/auth/oidc/start',
      summary: 'Start signing in with the corporate identity provider',
      auth: { kind: 'public' },
      rateLimit: limits.signIn,
      schema: { body: z.strictObject({}), response: adminOidcStartSchema },
      successStatus: 200,
      handler: async (_request, context) => {
        const started = await auth.start();
        context.setCookie(ADMIN_FLOW_COOKIE, started.flowId, new Date(Date.now() + FLOW_TTL_MS));
        return { authorizationUrl: started.url };
      },
    }),
    defineAdminRoute({
      id: 'admin.oidc_callback',
      method: 'POST',
      url: '/admin/v1/auth/oidc/callback',
      summary: 'Finish the identity-provider step (then the security key is needed)',
      auth: { kind: 'public' },
      rateLimit: limits.signIn,
      schema: { body: adminOidcCallbackSchema, response: adminSessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        const result = await auth.callback(
          context.cookie(ADMIN_FLOW_COOKIE),
          body.code,
          body.state,
          {
            ip: context.clientIp,
            userAgent: context.userAgent,
          },
        );
        context.clearCookie(ADMIN_FLOW_COOKIE);
        context.setCookie(ADMIN_SESSION_COOKIE, result.token, result.expiresAt);
        context.auditTarget('admin', result.adminId);
        return { stage: result.stage };
      },
    }),
    defineAdminRoute({
      id: 'admin.key_options',
      method: 'POST',
      url: '/admin/v1/auth/key/options',
      summary: 'Options to register or use your security key',
      auth: { kind: 'session', stages: ['key'] },
      rateLimit: limits.signIn,
      schema: { body: z.strictObject({}), response: adminKeyOptionsSchema },
      successStatus: 200,
      handler: (_request, context) => auth.keyOptions(context.admin),
    }),
    defineAdminRoute({
      id: 'admin.key_verify',
      method: 'POST',
      url: '/admin/v1/auth/key/verify',
      summary: 'Verify the security key; the session becomes active',
      auth: { kind: 'session', stages: ['key'] },
      rateLimit: limits.signIn,
      schema: { body: adminKeyVerifySchema, response: adminSessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        const activated = await auth.keyVerify(context.admin, body);
        context.setCookie(ADMIN_SESSION_COOKIE, activated.token, activated.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineAdminRoute({
      id: 'admin.reauth_options',
      method: 'POST',
      url: '/admin/v1/auth/reauth/options',
      summary: 'Confirm it is you with your security key (sensitive actions)',
      auth: { kind: 'session' },
      rateLimit: limits.signIn,
      schema: { body: z.strictObject({}), response: adminKeyOptionsSchema },
      successStatus: 200,
      handler: (_request, context) => auth.reauthOptions(context.admin),
    }),
    defineAdminRoute({
      id: 'admin.reauth_verify',
      method: 'POST',
      url: '/admin/v1/auth/reauth/verify',
      summary: 'Verify the confirmation',
      auth: { kind: 'session' },
      rateLimit: limits.signIn,
      schema: { body: adminKeyVerifySchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await auth.reauthVerify(context.admin, body);
        return ok;
      },
    }),
    defineAdminRoute({
      id: 'admin.logout',
      method: 'POST',
      url: '/admin/v1/auth/logout',
      summary: 'Sign out of the admin console',
      auth: { kind: 'session', stages: ['key', 'active'] },
      rateLimit: limits.signIn,
      schema: { body: z.strictObject({}), response: okResponseSchema },
      successStatus: 200,
      handler: async (_request, context) => {
        await auth.logout(context.admin);
        context.clearCookie(ADMIN_SESSION_COOKIE);
        return ok;
      },
    }),
    defineAdminRoute({
      id: 'admin.me',
      method: 'GET',
      url: '/admin/v1/me',
      summary: 'Who you are, your current roles and what they allow',
      auth: { kind: 'session' },
      rateLimit: limits.read,
      schema: { response: adminMeSchema },
      successStatus: 200,
      handler: async (_request, context) => {
        const me = await directory.byId(context.admin.adminId);
        if (me === null) throw new AppError('UNAUTHENTICATED');
        const current = await directory.roles(me.id);
        const stepUp = context.admin.reauthenticatedAt;
        return {
          id: me.id,
          email: me.email,
          displayName: me.display_name,
          roles: current.map((r) => ({ role: r.role, expiresAt: r.expiresAt.toISOString() })),
          eligibleRoles: me.eligible_roles.filter(
            (r): r is 'super_admin' | 'security_admin' =>
              r === 'super_admin' || r === 'security_admin',
          ),
          capabilities: [...context.admin.capabilities].sort(),
          stepUpUntil:
            stepUp === null || Date.now() - stepUp.getTime() > ADMIN_STEP_UP_MS
              ? null
              : new Date(stepUp.getTime() + ADMIN_STEP_UP_MS).toISOString(),
        };
      },
    }),

    // ---- overview -----------------------------------------------------------------------------
    defineAdminRoute({
      id: 'admin.dashboard',
      method: 'GET',
      url: '/admin/v1/dashboard',
      summary: 'Aggregates: accounts, activity, moderation, approvals, queues',
      auth: session('dashboard'),
      rateLimit: limits.read,
      schema: { response: adminDashboardSchema },
      successStatus: 200,
      handler: () => admin.dashboard(),
    }),
    defineAdminRoute({
      id: 'admin.signups',
      method: 'GET',
      url: '/admin/v1/analytics/signups',
      summary: 'Sign-ups per day (small counts suppressed)',
      auth: session('analytics'),
      rateLimit: limits.read,
      schema: {
        querystring: z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(30) }),
        response: signupAnalyticsSchema,
      },
      successStatus: 200,
      handler: ({ query }) => admin.signups(query.days),
    }),
    defineAdminRoute({
      id: 'admin.health',
      method: 'GET',
      url: '/admin/v1/health',
      summary: 'Database, cache, storage and queue health',
      auth: session('health'),
      rateLimit: limits.read,
      schema: { response: healthSchema },
      successStatus: 200,
      handler: () => admin.health(),
    }),
    defineAdminRoute({
      id: 'admin.security_hotspots',
      method: 'GET',
      url: '/admin/v1/security/hotspots',
      summary: 'Networks with the most failed sign-ins',
      auth: session('securityEvents'),
      rateLimit: limits.read,
      schema: {
        querystring: z.strictObject({ hours: z.coerce.number().int().min(1).max(168).default(24) }),
        response: securityHotspotsSchema,
      },
      successStatus: 200,
      handler: ({ query }) => admin.hotspots(query.hours),
    }),

    // ---- people (always with a purpose) -------------------------------------------------------
    defineAdminRoute({
      id: 'admin.user_lookup',
      method: 'POST',
      url: '/admin/v1/users/lookup',
      summary: 'Find a person by exact email, username or id, for a purpose',
      auth: session('usersView'),
      rateLimit: limits.lookup,
      schema: { body: adminUserLookupSchema, response: adminUserSummarySchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        context.auditDetail('purpose', body.purpose);
        const found = await admin.lookup(context.admin, body.identifier, body.purpose);
        context.auditTarget('user', found.id);
        return found;
      },
    }),
    defineAdminRoute({
      id: 'admin.user_detail',
      method: 'GET',
      url: '/admin/v1/users/:userId',
      summary: 'A person’s account metadata (never content or secrets), for a purpose',
      auth: session('usersView'),
      rateLimit: limits.lookup,
      schema: {
        params: adminUserParamsSchema,
        querystring: purposeQuerySchema,
        response: adminUserDetailSchema,
      },
      successStatus: 200,
      handler: ({ params, query }, context) => {
        context.auditTarget('user', params.userId);
        context.auditDetail('purpose', query.purpose);
        return admin.userDetail(context.admin, params.userId, query.purpose);
      },
    }),
    defineAdminRoute({
      id: 'admin.user_revoke_sessions',
      method: 'POST',
      url: '/admin/v1/users/:userId/sessions/revoke',
      summary: 'Sign a person out (one session or all), for a purpose',
      auth: session('usersRevokeSessions', true),
      rateLimit: limits.write,
      schema: {
        params: adminUserParamsSchema,
        body: revokeUserSessionsSchema,
        response: z.object({ revoked: z.number().int() }),
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        context.auditTarget('user', params.userId);
        context.auditDetail('purpose', body.purpose);
        return {
          revoked: await admin.revokeSessions(
            context.admin,
            params.userId,
            body.purpose,
            body.sessionId,
          ),
        };
      },
    }),
    defineAdminRoute({
      id: 'admin.user_resend_verification',
      method: 'POST',
      url: '/admin/v1/users/:userId/resend-verification',
      summary: 'Send the email verification code again, for a ticket',
      auth: session('usersResendVerification'),
      rateLimit: limits.write,
      schema: {
        params: adminUserParamsSchema,
        body: purposeBodySchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        context.auditTarget('user', params.userId);
        context.auditDetail('purpose', body.purpose);
        await admin.resendVerification(context.admin, params.userId, body.purpose);
        return ok;
      },
    }),

    // ---- support tickets ----------------------------------------------------------------------
    defineAdminRoute({
      id: 'admin.ticket_create',
      method: 'POST',
      url: '/admin/v1/tickets',
      summary: 'Open a support ticket for a person (needed to look at their account)',
      auth: session('tickets'),
      rateLimit: limits.write,
      schema: { body: createTicketSchema, response: ticketSchema },
      successStatus: 201,
      handler: async ({ body }, context) => {
        const ticket = await admin.createTicket(context.admin, body);
        context.auditTarget('support_ticket', ticket.id);
        context.auditDetail('reference', body.reference);
        return ticket;
      },
    }),
    defineAdminRoute({
      id: 'admin.tickets',
      method: 'GET',
      url: '/admin/v1/tickets',
      summary: 'Support tickets',
      auth: session('tickets'),
      rateLimit: limits.read,
      schema: {
        querystring: z.strictObject({ status: z.enum(['open', 'closed']).default('open') }),
        response: ticketListSchema,
      },
      successStatus: 200,
      handler: async ({ query }) => ({ tickets: await admin.tickets(query.status) }),
    }),
    defineAdminRoute({
      id: 'admin.ticket_close',
      method: 'POST',
      url: '/admin/v1/tickets/:ticketId/close',
      summary: 'Close a ticket (its purpose ends)',
      auth: session('tickets'),
      rateLimit: limits.write,
      schema: { params: ticketParamsSchema, body: z.strictObject({}), response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        context.auditTarget('support_ticket', params.ticketId);
        await admin.closeTicket(params.ticketId);
        return ok;
      },
    }),

    // ---- four eyes ----------------------------------------------------------------------------
    defineAdminRoute({
      id: 'admin.approvals',
      method: 'GET',
      url: '/admin/v1/approvals',
      summary: 'Change requests waiting for (or decided by) a second admin',
      auth: session('approvalsRequest'),
      rateLimit: limits.read,
      schema: { querystring: approvalQuerySchema, response: approvalListSchema },
      successStatus: 200,
      handler: async ({ query }) => ({
        approvals: (await approvals.list(query.status)).map(approvalView),
      }),
    }),
    defineAdminRoute({
      id: 'admin.approval_request',
      method: 'POST',
      url: '/admin/v1/approvals',
      summary: 'Request a change (roles, eligibility, new admin, feature flag, staff role)',
      auth: session('approvalsRequest'),
      rateLimit: limits.write,
      schema: { body: requestApprovalSchema, response: approvalSchema },
      successStatus: 201,
      handler: async ({ body }, context) => {
        const row = await approvals.request(
          context.admin.adminId,
          roles(context.admin),
          body.payload,
          body.reason,
        );
        context.auditTarget('admin_approval', row.id);
        context.auditDetail('kind', body.payload.kind);
        return approvalView(row);
      },
    }),
    defineAdminRoute({
      id: 'admin.approval_approve',
      method: 'POST',
      url: '/admin/v1/approvals/:approvalId/approve',
      summary: 'Approve someone else’s request (it takes effect now)',
      auth: session('approvalsRequest', true),
      rateLimit: limits.write,
      schema: {
        params: approvalParamsSchema,
        body: decideApprovalSchema,
        response: approvalSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        context.auditTarget('admin_approval', params.approvalId);
        const row = await approvals.approve(
          context.admin.adminId,
          roles(context.admin),
          params.approvalId,
          body.note,
        );
        context.auditDetail('kind', row.kind);
        return approvalView(row);
      },
    }),
    defineAdminRoute({
      id: 'admin.approval_reject',
      method: 'POST',
      url: '/admin/v1/approvals/:approvalId/reject',
      summary: 'Reject someone else’s request',
      auth: session('approvalsRequest'),
      rateLimit: limits.write,
      schema: {
        params: approvalParamsSchema,
        body: decideApprovalSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        context.auditTarget('admin_approval', params.approvalId);
        await approvals.reject(
          context.admin.adminId,
          roles(context.admin),
          params.approvalId,
          body.note,
        );
        return ok;
      },
    }),
    defineAdminRoute({
      id: 'admin.approval_cancel',
      method: 'POST',
      url: '/admin/v1/approvals/:approvalId/cancel',
      summary: 'Withdraw your own request',
      auth: session('approvalsRequest'),
      rateLimit: limits.write,
      schema: {
        params: approvalParamsSchema,
        body: z.strictObject({}),
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params }, context) => {
        context.auditTarget('admin_approval', params.approvalId);
        await approvals.cancel(context.admin.adminId, params.approvalId);
        return ok;
      },
    }),

    // ---- admins, staff, flags, audit ------------------------------------------------------------
    defineAdminRoute({
      id: 'admin.admins',
      method: 'GET',
      url: '/admin/v1/admins',
      summary: 'Admin accounts, their roles and eligibility',
      auth: session('adminsView'),
      rateLimit: limits.read,
      schema: { response: adminListSchema },
      successStatus: 200,
      handler: async () => ({ admins: await admin.admins() }),
    }),
    defineAdminRoute({
      id: 'admin.admin_disable',
      method: 'POST',
      url: '/admin/v1/admins/:adminId/disable',
      summary: 'Disable an admin at once (roles revoked, signed out)',
      auth: session('adminsDisable', true),
      rateLimit: limits.write,
      schema: { params: adminParamsSchema, body: z.strictObject({}), response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        context.auditTarget('admin', params.adminId);
        if (!(await directory.disable(params.adminId))) throw new AppError('NOT_FOUND');
        await sessions.revokeAll(params.adminId);
        context.log.warn('admin.alert', { component: 'admin', check: 'admin_disabled' });
        return ok;
      },
    }),
    defineAdminRoute({
      id: 'admin.staff',
      method: 'GET',
      url: '/admin/v1/staff-roles',
      summary: 'Moderation roles held by user accounts (the in-app console)',
      auth: session('staffView'),
      rateLimit: limits.read,
      schema: { response: staffRoleListSchema },
      successStatus: 200,
      handler: async () => ({ staff: await admin.staff() }),
    }),
    defineAdminRoute({
      id: 'admin.staff_revoke',
      method: 'POST',
      url: '/admin/v1/staff-roles/revoke',
      summary: 'Remove a moderation role at once',
      auth: session('staffRevoke', true),
      rateLimit: limits.write,
      schema: { body: revokeStaffRoleSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        context.auditTarget('user', body.userId);
        context.auditDetail('role', body.role);
        if (!(await admin.ports.moderation.revokeStaff(body.userId, body.role)))
          throw new AppError('NOT_FOUND');
        return ok;
      },
    }),
    defineAdminRoute({
      id: 'admin.flags',
      method: 'GET',
      url: '/admin/v1/flags',
      summary: 'Feature flags (changed only through a four-eyes request)',
      auth: session('flagsView'),
      rateLimit: limits.read,
      schema: { response: adminFlagListSchema },
      successStatus: 200,
      handler: async () => ({
        flags: (await admin.ports.flags.list()).map((flag) => ({
          ...flag,
          updatedAt: flag.updatedAt.toISOString(),
        })),
      }),
    }),
    defineAdminRoute({
      id: 'admin.audit',
      method: 'GET',
      url: '/admin/v1/audit',
      summary: 'The audit log (everything for security staff, otherwise your own actions)',
      auth: session('auditView'),
      rateLimit: limits.read,
      schema: { querystring: auditQuerySchema, response: auditPageSchema },
      successStatus: 200,
      handler: ({ query }, context) => admin.auditPage(context.admin, query),
    }),
  ];
}
