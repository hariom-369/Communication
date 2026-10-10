import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Admin console (docs/admin.md, ADR-050). Staff are separate identities (corporate identity
 * provider + hardware-bound security key) on a separate origin; every call is audited and every
 * look at a person's data is bound to a purpose (a support ticket, a moderation case, or — for
 * security staff — a written investigation reason).
 */

export const ADMIN_ROLES = [
  'super_admin',
  'security_admin',
  'moderator',
  'support_agent',
  'analyst',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
/** Granted just in time (requested, approved by another admin), for at most 8 hours. */
export const ELEVATED_ROLES = ['super_admin', 'security_admin'] as const;
export const MAX_ELEVATED_HOURS = 8;
export const MAX_BASE_ROLE_DAYS = 90;

// ---- sign-in ---------------------------------------------------------------------------------

/** `key_setup`: register a security key; `key`: use it; `active`: signed in. */
export const adminSessionStateSchema = z.object({
  stage: z.enum(['key_setup', 'key', 'active']),
});
export const adminOidcStartSchema = z.object({ authorizationUrl: z.string() });
export const adminOidcCallbackSchema = z.strictObject({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(256),
});
export const adminKeyOptionsSchema = z.object({ flowId: z.string(), options: z.unknown() });
export const adminKeyVerifySchema = z.strictObject({
  flowId: z.string().min(1).max(100),
  response: z.record(z.string(), z.unknown()),
  name: z.string().trim().min(1).max(64).optional(),
});

export const adminMeSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  roles: z.array(z.object({ role: z.enum(ADMIN_ROLES), expiresAt: z.string() })),
  eligibleRoles: z.array(z.enum(ELEVATED_ROLES)),
  capabilities: z.array(z.string()),
  /** Until when sensitive actions are allowed without confirming with the key again. */
  stepUpUntil: z.string().nullable(),
});
export type AdminMe = z.infer<typeof adminMeSchema>;

// ---- purpose binding -------------------------------------------------------------------------

/**
 * Why a person's data is looked at: `ticket:<id>` (support), `case:<id>` (moderation) or
 * `investigation:<reason>` (security staff only; the reason is recorded).
 */
export const purposeSchema = z
  .string()
  .trim()
  .max(520)
  .regex(/^(ticket:[0-9a-f-]{36}|case:[0-9a-f-]{36}|investigation:.{10,500})$/s, {
    message: 'Give a ticket, a case or an investigation reason (at least 10 characters).',
  });
export const purposeQuerySchema = z.strictObject({ purpose: purposeSchema });

export const adminUserLookupSchema = z.strictObject({
  identifier: z.string().trim().min(1).max(254),
  purpose: purposeSchema,
});
export const adminUserParamsSchema = z.strictObject({ userId: idSchema });

export const adminUserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export const adminUserDetailSchema = adminUserSummarySchema.extend({
  credentials: z.object({
    hasPassword: z.boolean(),
    passkeyCount: z.number().int(),
    totpEnabled: z.boolean(),
    recoveryCodesRemaining: z.number().int(),
  }),
  devices: z.array(
    z.object({ id: z.string(), label: z.string(), createdAt: z.string(), revoked: z.boolean() }),
  ),
  sessions: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      lastSeenAt: z.string(),
      userAgent: z.string(),
      ipPrefix: z.string(),
    }),
  ),
  loginEvents: z.array(
    z.object({
      kind: z.string(),
      method: z.string(),
      ipPrefix: z.string(),
      userAgent: z.string(),
      createdAt: z.string(),
    }),
  ),
  standing: z.object({ status: z.string(), suspendedUntil: z.string().nullable() }),
  /** Plan only: no payment details exist at Tessera (they stay with the provider). */
  billing: z.object({
    tier: z.string(),
    planName: z.string().nullable(),
    status: z.string().nullable(),
    provider: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: z.string().nullable(),
  }),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const revokeUserSessionsSchema = z.strictObject({
  purpose: purposeSchema,
  /** One session, or all of them. */
  sessionId: idSchema.optional(),
});
export const purposeBodySchema = z.strictObject({ purpose: purposeSchema });

// ---- support tickets -------------------------------------------------------------------------

export const createTicketSchema = z.strictObject({
  /** The help-desk reference the request came in under. */
  reference: z.string().trim().min(1).max(100),
  identifier: z.string().trim().min(1).max(254),
  reason: z.string().trim().min(5).max(500),
});
export const ticketSchema = z.object({
  id: z.string(),
  reference: z.string(),
  subjectUserId: z.string(),
  subjectUsername: z.string(),
  reason: z.string(),
  status: z.enum(['open', 'closed']),
  createdBy: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export const ticketListSchema = z.object({ tickets: z.array(ticketSchema) });
export const ticketParamsSchema = z.strictObject({ ticketId: idSchema });

// ---- approvals (four eyes) -------------------------------------------------------------------

export const STAFF_ROLE_VALUES = ['moderator', 'senior_moderator', 'legal'] as const;

export const approvalPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('role_grant'),
    adminId: idSchema,
    role: z.enum(ADMIN_ROLES),
    /** Elevated roles: at most 8 hours; others: at most 90 days. */
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * MAX_BASE_ROLE_DAYS),
  }),
  z.strictObject({
    kind: z.literal('eligibility'),
    adminId: idSchema,
    roles: z.array(z.enum(ELEVATED_ROLES)).max(2),
  }),
  z.strictObject({
    kind: z.literal('admin_create'),
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal('feature_flag'),
    key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
  }),
  z.strictObject({
    kind: z.literal('staff_role'),
    username: z.string().trim().min(1).max(64),
    role: z.enum(STAFF_ROLE_VALUES),
    days: z.number().int().min(1).max(MAX_BASE_ROLE_DAYS),
  }),
]);
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

export const requestApprovalSchema = z.strictObject({
  payload: approvalPayloadSchema,
  reason: z.string().trim().min(5).max(500),
});
export const decideApprovalSchema = z.strictObject({
  note: z.string().trim().max(500).default(''),
});
export const approvalSchema = z.object({
  id: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string(),
  requestedBy: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string(),
});
export const approvalListSchema = z.object({ approvals: z.array(approvalSchema) });
export const approvalParamsSchema = z.strictObject({ approvalId: idSchema });
export const approvalQuerySchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).default('pending'),
});

// ---- admins, staff roles -----------------------------------------------------------------------

export const adminListSchema = z.object({
  admins: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      displayName: z.string(),
      status: z.enum(['active', 'disabled']),
      roles: z.array(z.object({ role: z.enum(ADMIN_ROLES), expiresAt: z.string() })),
      eligibleRoles: z.array(z.enum(ELEVATED_ROLES)),
      keys: z.number().int(),
    }),
  ),
});
export const adminParamsSchema = z.strictObject({ adminId: idSchema });

export const staffRoleListSchema = z.object({
  staff: z.array(
    z.object({
      userId: z.string(),
      username: z.string(),
      role: z.enum(STAFF_ROLE_VALUES),
      expiresAt: z.string(),
      grantedBy: z.string(),
    }),
  ),
});
export const revokeStaffRoleSchema = z.strictObject({
  userId: idSchema,
  role: z.enum(STAFF_ROLE_VALUES),
});

// ---- feature flags -----------------------------------------------------------------------------

export const featureFlagsSchema = z.object({ flags: z.record(z.string(), z.boolean()) });
export const adminFlagListSchema = z.object({
  flags: z.array(
    z.object({
      key: z.string(),
      description: z.string(),
      kind: z.enum(['product', 'security']),
      enabled: z.boolean(),
      rolloutPercent: z.number().int(),
      /** The admin who approved the last change (null: the shipped default). */
      updatedBy: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
});

// ---- dashboard, analytics, health, security, audit --------------------------------------------

export const adminDashboardSchema = z.object({
  users: z.object({
    total: z.number().int(),
    newLast24h: z.number().int(),
    activeLast24h: z.number().int(),
  }),
  messagesLast24h: z.number().int(),
  moderation: z.object({ openCases: z.number().int(), missedDeadlines: z.number().int() }),
  pendingApprovals: z.number().int(),
  notificationQueue: z.number().int(),
});
/** Daily counts; values below the anonymity threshold are reported as null. */
export const signupAnalyticsSchema = z.object({
  threshold: z.number().int(),
  days: z.array(z.object({ date: z.string(), signups: z.number().int().nullable() })),
});
export const healthSchema = z.object({
  checks: z.array(
    z.object({ name: z.string(), ok: z.boolean(), latencyMs: z.number(), detail: z.string() }),
  ),
});
export const securityHotspotsSchema = z.object({
  since: z.string(),
  hotspots: z.array(
    z.object({ ipPrefix: z.string(), failures: z.number().int(), accounts: z.number().int() }),
  ),
});
export const auditQuerySchema = z.strictObject({
  action: z.string().max(100).optional(),
  actorId: idSchema.optional(),
  targetId: idSchema.optional(),
  /** Entries older than this sequence number (paging backwards). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const auditPageSchema = z.object({
  entries: z.array(
    z.object({
      seq: z.number().int(),
      at: z.string(),
      actorKind: z.string(),
      actorId: z.string().nullable(),
      action: z.string(),
      targetKind: z.string().nullable(),
      targetId: z.string().nullable(),
      details: z.record(z.string(), z.unknown()),
    }),
  ),
  /** Null when the whole hash chain verifies, else the first broken entry. */
  chainBrokenAt: z.string().nullable(),
  /** Only the viewer's own actions (roles without audit access). */
  ownOnly: z.boolean(),
});

export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type AdminDashboard = z.infer<typeof adminDashboardSchema>;
export type SignupAnalytics = z.infer<typeof signupAnalyticsSchema>;
export type HealthReport = z.infer<typeof healthSchema>;
export type SecurityHotspots = z.infer<typeof securityHotspotsSchema>;
export type AdminListEntry = z.infer<typeof adminListSchema>['admins'][number];
export type StaffRoleEntry = z.infer<typeof staffRoleListSchema>['staff'][number];
export type AuditPage = z.infer<typeof auditPageSchema>;
