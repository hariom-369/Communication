import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Abuse prevention and moderation (docs/moderation.md, ADR-021, ADR-049).
 *
 * Private, end-to-end encrypted content reaches Tessera only when a participant reports it: the
 * reporter's device sends exactly the messages they chose, encrypted to the moderation key
 * (HPKE, RFC 9180). Messages carry a franking commitment and server tag (ADR-021), so the server
 * can verify that the reported plaintext is what the sender's device sent — "content verified".
 * Messages without franking (older clients) are "unverified": severe actions need corroboration.
 */

export const REPORT_CATEGORIES = [
  'spam',
  'scam',
  'harassment',
  'hate',
  'violence_threat',
  'self_harm',
  'sexual_content',
  'ncii',
  'synthetic_media',
  'csam',
  'terrorism',
  'impersonation',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_TARGET_KINDS = [
  'user',
  'conversation',
  'channel',
  'post',
  'comment',
  'community',
] as const;
export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];

/** Messages a reporter may select, and preceding context they may add (docs/moderation.md §3). */
export const MAX_REPORTED_MESSAGES = 40;
export const MAX_REPORT_CONTEXT = 10;
export const MAX_REPORT_MEDIA = 10;
/** Encrypted bundle limit (base64 of the HPKE ciphertext). */
export const MAX_REPORT_BUNDLE_BYTES = 6 * 1024 * 1024;
/** HPKE info string for report bundles (binds the ciphertext to this use). */
export const REPORT_HPKE_INFO = 'tessera report bundle v1' as const;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** A report bundle encrypted to the moderation key: HPKE `enc` and ciphertext. */
export const sealedBundleSchema = z.strictObject({
  enc: base64url.max(200),
  ciphertext: base64.max(Math.ceil((MAX_REPORT_BUNDLE_BYTES * 4) / 3) + 4),
});

/** What the reporter's device puts inside the sealed bundle (validated after decryption). */
export const reportBundleSchema = z.object({
  v: z.literal(1),
  conversationId: z.string(),
  reporterId: z.string(),
  messages: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        senderUserId: z.string(),
        senderDeviceId: z.string(),
        serverTime: z.string(),
        clientMessageId: z.string(),
        /** Chosen by the reporter (the rest is context they added). */
        selected: z.boolean(),
        /** The exact decrypted content (JSON text), as committed to by the sender. */
        plaintext: z.string().max(70_000),
        commitment: z.string().nullable(),
        frankingTag: z.string().nullable(),
      }),
    )
    .min(1)
    .max(MAX_REPORTED_MESSAGES + MAX_REPORT_CONTEXT),
  media: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        name: z.string().max(255),
        mime: z.string().max(127),
        data: base64,
      }),
    )
    .max(MAX_REPORT_MEDIA),
});
export type ReportBundle = z.infer<typeof reportBundleSchema>;

export const reportTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: idSchema }),
  z.strictObject({
    kind: z.literal('conversation'),
    conversationId: idSchema,
    /** The reported person (direct chats), if any. */
    userId: idSchema.optional(),
    /** Sequence numbers in the bundle, so the server can check them before decrypting. */
    seqs: z
      .array(z.number().int().positive())
      .max(MAX_REPORTED_MESSAGES + MAX_REPORT_CONTEXT)
      .default([]),
    bundle: sealedBundleSchema.nullable().default(null),
  }),
  z.strictObject({ kind: z.literal('channel'), channelId: idSchema }),
  z.strictObject({ kind: z.literal('post'), channelId: idSchema, postId: idSchema }),
  z.strictObject({ kind: z.literal('comment'), channelId: idSchema, commentId: idSchema }),
  z.strictObject({ kind: z.literal('community'), communityId: idSchema }),
]);
export type ReportTarget = z.infer<typeof reportTargetSchema>;

export const createReportSchema = z.strictObject({
  target: reportTargetSchema,
  category: z.enum(REPORT_CATEGORIES),
  details: z.string().trim().max(1000).default(''),
  /** Also block the person (user and direct-chat reports). */
  block: z.boolean().default(false),
});
export type CreateReport = z.infer<typeof createReportSchema>;

export const reportReceiptSchema = z.object({ id: z.string() });

export const myReportSchema = z.object({
  id: z.string(),
  targetKind: z.enum(REPORT_TARGET_KINDS),
  category: z.enum(REPORT_CATEGORIES),
  createdAt: z.string(),
  /** received → reviewed; the outcome is shown without details about the other person. */
  status: z.enum(['received', 'action_taken', 'no_violation']),
});
export const myReportsSchema = z.object({ reports: z.array(myReportSchema) });
export type MyReport = z.infer<typeof myReportSchema>;

export const moderationKeySchema = z.object({
  /** HPKE public key (raw, base64url) and the RFC 9180 suite it is used with. */
  publicKey: z.string(),
  kem: z.literal('DHKEM(P-256, HKDF-SHA256)'),
  kdf: z.literal('HKDF-SHA256'),
  aead: z.literal('AES-128-GCM'),
  info: z.literal(REPORT_HPKE_INFO),
});

// ---- blocks ----------------------------------------------------------------------------------

export const blockUserSchema = z.strictObject({ userId: idSchema });
export const blockedUserSchema = z.object({
  userId: z.string(),
  username: z.string(),
  createdAt: z.string(),
});
export const blockedListSchema = z.object({ blocked: z.array(blockedUserSchema) });
export const blockParamsSchema = z.strictObject({ userId: idSchema });

// ---- account standing and appeals --------------------------------------------------------------

export const ENFORCEMENT_ACTIONS = [
  'warn',
  'restrict',
  'suspend',
  'ban',
  'remove_content',
  'channel_unlist',
  'channel_suspend',
  'legal_referral',
] as const;
export type EnforcementAction = (typeof ENFORCEMENT_ACTIONS)[number];
export const RESTRICTIONS = ['new_chats', 'creation'] as const;
export type Restriction = (typeof RESTRICTIONS)[number];

/** Reason codes shown to the person (with plain-language text in the app). */
export const REASON_CODES = [
  ...REPORT_CATEGORIES.filter((c) => c !== 'other'),
  'other_policy',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Plain-language reasons, shown in notices to the person concerned. */
export const REASON_TEXT: Record<ReasonCode, string> = {
  spam: 'Spam or unwanted bulk messages',
  scam: 'Scams or fraud',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  violence_threat: 'Threats of violence',
  self_harm: 'Promoting self-harm',
  sexual_content: 'Unwanted sexual content',
  ncii: 'Sharing intimate images without consent',
  synthetic_media: 'Deceptive synthetic (deepfake) media',
  csam: 'A serious violation of our rules',
  terrorism: 'Terrorist or violent extremist content',
  impersonation: 'Impersonation',
  other_policy: 'Breaking our community rules',
};

/** Appeals are accepted for this long after an action (docs/moderation.md §7). */
export const APPEAL_WINDOW_DAYS = 30;

export const noticeSchema = z.object({
  actionId: z.string(),
  action: z.enum(ENFORCEMENT_ACTIONS),
  restriction: z.enum(RESTRICTIONS).nullable(),
  reasonCode: z.string(),
  /** What it concerns, e.g. "your account" or a channel post. */
  targetKind: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  active: z.boolean(),
  appeal: z
    .object({
      status: z.enum(['open', 'upheld', 'overturned']),
      decidedAt: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  appealable: z.boolean(),
});
export type Notice = z.infer<typeof noticeSchema>;

export const standingSchema = z.object({
  status: z.enum(['good', 'restricted', 'suspended', 'banned']),
  suspendedUntil: z.string().nullable(),
  notices: z.array(noticeSchema),
});
export type Standing = z.infer<typeof standingSchema>;

export const createAppealSchema = z.strictObject({
  actionId: idSchema,
  statement: z.string().trim().min(1).max(2000),
});

// ---- grievances (IT Rules grievance officer; anyone may file) -------------------------------

export const GRIEVANCE_KINDS = ['grievance', 'ncii', 'synthetic_media'] as const;
export const LEGAL_ORDER_KINDS = ['court_order', 'government_order'] as const;

export const createGrievanceSchema = z.strictObject({
  kind: z.enum(GRIEVANCE_KINDS),
  /** How to reach the complainant (an email address). */
  contact: z.email().max(254),
  description: z.string().trim().min(10).max(4000),
  /** Links or identifiers of the content concerned. */
  reference: z.string().trim().max(500).default(''),
});
export const grievanceReceiptSchema = z.object({
  id: z.string(),
  acknowledgeBy: z.string(),
  resolveBy: z.string(),
});

// ---- link safety (k-anonymous prefix lookups) ------------------------------------------------

export const linkPrefixesSchema = z.object({
  /** Concatenated 4-byte SHA-256 prefixes of blocked hosts (base64). */
  prefixes: z.string(),
  version: z.string(),
});
export const linkHashQuerySchema = z.strictObject({ prefix: z.string().regex(/^[0-9a-f]{8}$/) });
export const linkHashesSchema = z.object({
  hashes: z.array(z.object({ sha256: z.string(), category: z.string() })),
});

// ---- staff: cases ----------------------------------------------------------------------------

export const STAFF_ROLES = ['moderator', 'senior_moderator', 'legal'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const CASE_STATUSES = ['open', 'actioned', 'dismissed'] as const;

export const staffMeSchema = z.object({ roles: z.array(z.enum(STAFF_ROLES)) });

export const caseQuerySchema = z.strictObject({
  status: z.enum(CASE_STATUSES).default('open'),
  category: z
    .enum([...REPORT_CATEGORIES, 'grievance', 'court_order', 'government_order'])
    .optional(),
});

export const caseSummarySchema = z.object({
  id: z.string(),
  subjectKind: z.enum([...REPORT_TARGET_KINDS, 'grievance']),
  subjectId: z.string(),
  subjectLabel: z.string(),
  category: z.string(),
  source: z.enum(['report', 'grievance', 'legal_order', 'automated']),
  priority: z.number().int(),
  status: z.enum(CASE_STATUSES),
  reportCount: z.number().int(),
  ackDueAt: z.string(),
  dueAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  breached: z.boolean(),
  legalHold: z.boolean(),
  assignedTo: z.string().nullable(),
  openedAt: z.string(),
});
export type CaseSummary = z.infer<typeof caseSummarySchema>;
export const caseListSchema = z.object({ cases: z.array(caseSummarySchema) });

export const caseActionSchema = z.object({
  id: z.string(),
  action: z.enum(ENFORCEMENT_ACTIONS),
  restriction: z.enum(RESTRICTIONS).nullable(),
  reasonCode: z.string(),
  note: z.string(),
  status: z.enum(['pending_review', 'active', 'reverted', 'rejected']),
  targetKind: z.string(),
  targetId: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: z.string(),
});

export const caseDetailSchema = caseSummarySchema.extend({
  subjectUserId: z.string().nullable(),
  reports: z.array(
    z.object({
      id: z.string(),
      reporter: z.string().nullable(),
      category: z.string(),
      details: z.string(),
      verification: z.enum(['content_verified', 'unverified', 'server_content', 'none']),
      evidenceId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['e2ee_bundle', 'public_snapshot']),
      size: z.number().int(),
      mediaCount: z.number().int(),
      csamMatch: z.boolean(),
      sha256: z.string(),
      createdAt: z.string(),
    }),
  ),
  grievances: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      contact: z.string(),
      description: z.string(),
      reference: z.string(),
      createdAt: z.string(),
    }),
  ),
  actions: z.array(caseActionSchema),
  /** Earlier actions against the same person (other cases). */
  history: z.array(caseActionSchema),
  events: z.array(
    z.object({
      kind: z.string(),
      actor: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
});
export type CaseDetail = z.infer<typeof caseDetailSchema>;

export const caseParamsSchema = z.strictObject({ caseId: idSchema });
export const evidenceParamsSchema = z.strictObject({ caseId: idSchema, evidenceId: idSchema });
export const actionParamsSchema = z.strictObject({ actionId: idSchema });
export const appealParamsSchema = z.strictObject({ appealId: idSchema });

/** Decrypted evidence, for the moderator viewing it (every view is recorded). */
export const evidenceViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('e2ee_bundle'), bundle: reportBundleSchema }),
  z.object({ kind: z.literal('public_snapshot'), snapshot: z.record(z.string(), z.unknown()) }),
]);
export type EvidenceView = z.infer<typeof evidenceViewSchema>;

export const takeActionSchema = z
  .strictObject({
    action: z.enum(ENFORCEMENT_ACTIONS),
    reasonCode: z.enum(REASON_CODES),
    restriction: z.enum(RESTRICTIONS).optional(),
    /** Restrictions and suspensions; omitted for permanent actions. */
    durationHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
    note: z.string().trim().max(2000).default(''),
  })
  .refine((value) => value.action !== 'restrict' || value.restriction !== undefined, {
    message: 'Choose what to restrict.',
    path: ['restriction'],
  })
  .refine(
    (value) => !['restrict', 'suspend'].includes(value.action) || value.durationHours !== undefined,
    { message: 'Choose how long.', path: ['durationHours'] },
  );

export const reviewDecisionSchema = z.strictObject({
  note: z.string().trim().max(2000).default(''),
});
export const caseNoteSchema = z.strictObject({ note: z.string().trim().min(1).max(2000) });
export const dismissCaseSchema = z.strictObject({
  reasonCode: z.enum(['no_violation', 'insufficient_evidence', 'duplicate', 'false_report']),
  note: z.string().trim().max(2000).default(''),
});

export const appealSummarySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  action: caseActionSchema,
  statement: z.string(),
  user: z.string(),
  createdAt: z.string(),
});
export const appealListSchema = z.object({ appeals: z.array(appealSummarySchema) });
export type AppealSummary = z.infer<typeof appealSummarySchema>;
export const decideAppealSchema = z.strictObject({
  outcome: z.enum(['upheld', 'overturned']),
  reason: z.string().trim().min(1).max(2000),
});

export const legalOrderSchema = z.strictObject({
  kind: z.enum(LEGAL_ORDER_KINDS),
  reference: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(4000),
  subject: z.strictObject({
    kind: z.enum(['user', 'channel', 'post', 'comment', 'community']),
    id: idSchema,
    /** The channel of a post or comment. */
    channelId: idSchema.optional(),
  }),
});

export const transparencyQuerySchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});
export const transparencySchema = z.object({
  month: z.string(),
  reportsReceived: z.number().int(),
  grievancesReceived: z.number().int(),
  legalOrdersReceived: z.number().int(),
  casesOpened: z.number().int(),
  casesResolved: z.number().int(),
  slaBreaches: z.number().int(),
  byCategory: z.record(z.string(), z.number().int()),
  actions: z.record(z.string(), z.number().int()),
  appeals: z.object({
    received: z.number().int(),
    upheld: z.number().int(),
    overturned: z.number().int(),
  }),
  /** Proactive actions on public surfaces (automated detection). */
  automated: z.number().int(),
});
export type Transparency = z.infer<typeof transparencySchema>;

export const blocklistEntrySchema = z.strictObject({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+$/, { message: 'Enter a host name such as example.com' }),
  category: z.enum(['phishing', 'malware', 'scam', 'csam']),
});
export const blocklistSchema = z.object({
  entries: z.array(z.object({ host: z.string(), category: z.string(), createdAt: z.string() })),
});
export type BlocklistItem = z.infer<typeof blocklistSchema>['entries'][number];
export const blocklistParamsSchema = z.strictObject({ host: z.string().min(1).max(253) });

export const csamHashImportSchema = z.strictObject({
  hashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(10_000),
  source: z.string().trim().min(1).max(200),
});
export const csamHashStatsSchema = z.object({ count: z.number().int() });
