import {
  actionParamsSchema,
  appealListSchema,
  appealParamsSchema,
  blockedListSchema,
  blocklistEntrySchema,
  blocklistParamsSchema,
  blocklistSchema,
  blockParamsSchema,
  blockUserSchema,
  caseDetailSchema,
  caseListSchema,
  caseNoteSchema,
  caseParamsSchema,
  caseQuerySchema,
  createAppealSchema,
  createGrievanceSchema,
  createReportSchema,
  csamHashImportSchema,
  csamHashStatsSchema,
  decideAppealSchema,
  dismissCaseSchema,
  evidenceParamsSchema,
  evidenceViewSchema,
  grievanceReceiptSchema,
  legalOrderSchema,
  linkHashesSchema,
  linkHashQuerySchema,
  linkPrefixesSchema,
  MAX_REPORT_BUNDLE_BYTES,
  moderationKeySchema,
  myReportsSchema,
  okResponseSchema,
  REPORT_HPKE_INFO,
  reportReceiptSchema,
  reviewDecisionSchema,
  staffMeSchema,
  standingSchema,
  takeActionSchema,
  transparencyQuerySchema,
  transparencySchema,
} from '@tessera/validation';
import { AppError } from '@tessera/platform';
import { z } from 'zod';

import {
  defineRoute,
  ownAccount,
  publicAccess,
  type Policy,
  type RouteContext,
  type RouteDefinition,
} from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { ModerationService } from './moderation.js';

export interface ModerationModuleDeps {
  readonly moderation: ModerationService;
}

const policy = (
  name: string,
  limit: number,
  periodMs: number,
  burst: number,
  onStoreFailure: 'open' | 'closed' = 'open',
): RateLimitPolicy => ({ name: `moderation.${name}`, limit, periodMs, burst, onStoreFailure });

const HOUR = 3_600_000;
const limits = {
  read: policy('read', 600, 60_000, 120),
  block: policy('block', 100, HOUR, 30),
  // Reports cost review time; a flood of them is itself abuse.
  report: policy('report', 30, HOUR, 10, 'closed'),
  appeal: policy('appeal', 10, 24 * HOUR, 5, 'closed'),
  // Public form: per client address.
  grievance: policy('grievance', 5, HOUR, 3, 'closed'),
  links: policy('links', 600, 60_000, 200),
  staffRead: policy('staff_read', 1200, 60_000, 300),
  staffWrite: policy('staff_write', 600, HOUR, 120),
} satisfies Record<string, RateLimitPolicy>;

const signedIn = { auth: { kind: 'session' }, authorize: ownAccount } as const;
const readOnly = { kind: 'none', reason: 'Read-only' } as const;
const onCase = {
  kind: 'none',
  reason: 'Recorded on the moderation case (append-only case events)',
} as const;
const ok = { ok: true as const };
const meta = (context: RouteContext): string => context.requestId;

/** Staff routes: the service checks the exact role; this keeps everyone else out up front. */
function staffPolicy(moderation: ModerationService): Policy {
  return {
    name: 'moderation_staff',
    allows: async (context) =>
      context.session !== null && (await moderation.staffRoles(context.session.userId)).length > 0,
  };
}

export function moderationRoutes(deps: ModerationModuleDeps): RouteDefinition[] {
  const { moderation } = deps;
  const staff = {
    tags: ['moderation-staff'],
    auth: { kind: 'session' },
    authorize: staffPolicy(moderation),
  } as const;
  const staffStepUp = { ...staff, auth: { kind: 'session', stepUp: true } } as const;

  return [
    // ---- people: blocks ------------------------------------------------------------------------
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.blocks_list',
      method: 'GET',
      url: '/api/v1/blocks',
      summary: 'People you blocked',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: blockedListSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        blocked: await moderation.blocked(context.session.userId),
      }),
    }),
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.block',
      method: 'POST',
      url: '/api/v1/blocks',
      summary: 'Block a person: no messages, calls, group adds or presence between you',
      rateLimit: limits.block,
      audit: {
        kind: 'none',
        reason: "The person's own safety setting; visible in their block list",
      },
      schema: { body: blockUserSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await moderation.block(context.session.userId, body.userId);
        return ok;
      },
    }),
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.unblock',
      method: 'DELETE',
      url: '/api/v1/blocks/:userId',
      summary: 'Unblock a person',
      rateLimit: limits.block,
      audit: { kind: 'none', reason: "The person's own safety setting" },
      schema: { params: blockParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await moderation.unblock(context.session.userId, params.userId);
        return ok;
      },
    }),

    // ---- people: reports ----------------------------------------------------------------------
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.key',
      method: 'GET',
      url: '/api/v1/moderation/key',
      summary: 'The public key report bundles are encrypted to (HPKE, RFC 9180)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: moderationKeySchema },
      successStatus: 200,
      handler: () => {
        const publicKey = moderation.moderationPublicKey();
        if (publicKey === null)
          throw new AppError('SERVICE_UNAVAILABLE', {
            detail: 'Reports with messages are not available on this server.',
          });
        return Promise.resolve({
          publicKey,
          kem: 'DHKEM(P-256, HKDF-SHA256)' as const,
          kdf: 'HKDF-SHA256' as const,
          aead: 'AES-128-GCM' as const,
          info: REPORT_HPKE_INFO,
        });
      },
    }),
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.report',
      method: 'POST',
      url: '/api/v1/reports',
      summary:
        'Report a person, chat, channel, post, comment or community (messages only as you select them, encrypted to the moderation key)',
      rateLimit: limits.report,
      audit: onCase,
      bodyLimit: Math.ceil((MAX_REPORT_BUNDLE_BYTES * 4) / 3) + 64 * 1024,
      schema: { body: createReportSchema, response: reportReceiptSchema },
      successStatus: 201,
      handler: ({ body }, context) => moderation.report(context.session.userId, body),
    }),
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.my_reports',
      method: 'GET',
      url: '/api/v1/reports',
      summary: 'Your reports and whether they were acted on',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: myReportsSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        reports: await moderation.myReports(context.session.userId),
      }),
    }),

    // ---- people: account standing and appeals (reachable while suspended) ---------------------
    defineRoute({
      tags: ['safety'],
      auth: { kind: 'session', whileSuspended: true },
      authorize: ownAccount,
      id: 'moderation.standing',
      method: 'GET',
      url: '/api/v1/account/standing',
      summary: 'Your account status: warnings, restrictions, suspensions and appeals',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: standingSchema },
      successStatus: 200,
      handler: (_request, context) => moderation.standing(context.session.userId),
    }),
    defineRoute({
      tags: ['safety'],
      auth: { kind: 'session', whileSuspended: true },
      authorize: ownAccount,
      id: 'moderation.appeal',
      method: 'POST',
      url: '/api/v1/account/appeals',
      summary: 'Appeal a moderation decision (reviewed by someone who did not take it)',
      rateLimit: limits.appeal,
      audit: onCase,
      schema: { body: createAppealSchema, response: okResponseSchema },
      successStatus: 201,
      handler: async ({ body }, context) => {
        await moderation.appeal(context.session.userId, body.actionId, body.statement);
        return ok;
      },
    }),

    // ---- anyone: grievances --------------------------------------------------------------------
    defineRoute({
      tags: ['safety'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      id: 'moderation.grievance',
      method: 'POST',
      url: '/api/v1/grievances',
      summary: 'File a complaint with the grievance officer (no account needed)',
      rateLimit: limits.grievance,
      audit: onCase,
      schema: { body: createGrievanceSchema, response: grievanceReceiptSchema },
      successStatus: 201,
      handler: ({ body }, context) => moderation.grievance(context.session?.userId ?? null, body),
    }),

    // ---- link safety (k-anonymous lookups) ----------------------------------------------------
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.link_prefixes',
      method: 'GET',
      url: '/api/v1/link-safety/prefixes',
      summary: 'Short hash prefixes of harmful hosts (devices check links locally)',
      rateLimit: limits.links,
      audit: readOnly,
      schema: { response: linkPrefixesSchema },
      successStatus: 200,
      handler: () => moderation.linkPrefixes(),
    }),
    defineRoute({
      ...signedIn,
      tags: ['safety'],
      id: 'moderation.link_hashes',
      method: 'GET',
      url: '/api/v1/link-safety/hashes',
      summary: 'Full hashes for one prefix (the server never learns the link)',
      rateLimit: limits.links,
      audit: readOnly,
      schema: { querystring: linkHashQuerySchema, response: linkHashesSchema },
      successStatus: 200,
      handler: async ({ query }) => ({ hashes: await moderation.linkHashes(query.prefix) }),
    }),

    // ---- staff ---------------------------------------------------------------------------------
    defineRoute({
      tags: ['moderation-staff'],
      ...signedIn,
      id: 'moderation.staff_me',
      method: 'GET',
      url: '/api/v1/moderation/me',
      summary: 'Your moderation roles (empty for everyone else)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: staffMeSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        roles: await moderation.staffRoles(context.session.userId),
      }),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.queue',
      method: 'GET',
      url: '/api/v1/moderation/cases',
      summary: 'Cases by priority and deadline',
      rateLimit: limits.staffRead,
      audit: readOnly,
      schema: { querystring: caseQuerySchema, response: caseListSchema },
      successStatus: 200,
      handler: async ({ query }, context) => ({
        cases: await moderation.queue(context.session.userId, query),
      }),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.case',
      method: 'GET',
      url: '/api/v1/moderation/cases/:caseId',
      summary: 'A case: reports, evidence (sealed), actions, history and timeline',
      rateLimit: limits.staffRead,
      audit: readOnly,
      schema: { params: caseParamsSchema, response: caseDetailSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        moderation.caseDetail(context.session.userId, params.caseId),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.evidence_view',
      method: 'POST',
      url: '/api/v1/moderation/cases/:caseId/evidence/:evidenceId/view',
      summary: 'Open evidence of this case (every view is recorded)',
      rateLimit: limits.staffWrite,
      audit: { kind: 'records', actions: ['moderation.evidence_viewed'] },
      schema: {
        params: evidenceParamsSchema,
        body: z.strictObject({}),
        response: evidenceViewSchema,
      },
      successStatus: 200,
      handler: ({ params }, context) =>
        moderation.viewEvidence(
          context.session.userId,
          params.caseId,
          params.evidenceId,
          meta(context),
        ),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.acknowledge',
      method: 'POST',
      url: '/api/v1/moderation/cases/:caseId/acknowledge',
      summary: 'Acknowledge a case and take it',
      rateLimit: limits.staffWrite,
      audit: onCase,
      schema: { params: caseParamsSchema, body: z.strictObject({}), response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await moderation.acknowledge(context.session.userId, params.caseId);
        return ok;
      },
    }),
    defineRoute({
      ...staff,
      id: 'moderation.note',
      method: 'POST',
      url: '/api/v1/moderation/cases/:caseId/notes',
      summary: 'Add an internal note to a case',
      rateLimit: limits.staffWrite,
      audit: onCase,
      schema: { params: caseParamsSchema, body: caseNoteSchema, response: okResponseSchema },
      successStatus: 201,
      handler: async ({ params, body }, context) => {
        await moderation.note(context.session.userId, params.caseId, body.note);
        return ok;
      },
    }),
    defineRoute({
      ...staff,
      id: 'moderation.take_action',
      method: 'POST',
      url: '/api/v1/moderation/cases/:caseId/actions',
      summary: 'Act on a case (bans and legal referrals wait for a second reviewer)',
      rateLimit: limits.staffWrite,
      audit: {
        kind: 'records',
        actions: [
          'moderation.warn',
          'moderation.restrict',
          'moderation.suspend',
          'moderation.ban',
          'moderation.remove_content',
          'moderation.channel_unlist',
          'moderation.channel_suspend',
          'moderation.legal_referral',
        ],
      },
      schema: {
        params: caseParamsSchema,
        body: takeActionSchema,
        response: z.object({ id: z.string(), status: z.enum(['active', 'pending_review']) }),
      },
      successStatus: 201,
      handler: ({ params, body }, context) =>
        moderation.takeAction(context.session.userId, params.caseId, body, meta(context)),
    }),
    defineRoute({
      ...staffStepUp,
      id: 'moderation.approve',
      method: 'POST',
      url: '/api/v1/moderation/actions/:actionId/approve',
      summary: 'Approve a ban or legal referral as the second reviewer',
      rateLimit: limits.staffWrite,
      audit: {
        kind: 'records',
        actions: ['moderation.ban_approved', 'moderation.legal_referral_approved'],
      },
      schema: {
        params: actionParamsSchema,
        body: reviewDecisionSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await moderation.approve(context.session.userId, params.actionId, body.note, meta(context));
        return ok;
      },
    }),
    defineRoute({
      ...staff,
      id: 'moderation.reject',
      method: 'POST',
      url: '/api/v1/moderation/actions/:actionId/reject',
      summary: 'Reject a proposed ban or legal referral',
      rateLimit: limits.staffWrite,
      audit: onCase,
      schema: {
        params: actionParamsSchema,
        body: reviewDecisionSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await moderation.reject(context.session.userId, params.actionId, body.note);
        return ok;
      },
    }),
    defineRoute({
      ...staffStepUp,
      id: 'moderation.revert',
      method: 'POST',
      url: '/api/v1/moderation/actions/:actionId/revert',
      summary: 'Reverse an action in effect',
      rateLimit: limits.staffWrite,
      audit: {
        kind: 'records',
        actions: [
          'moderation.warn_reverted',
          'moderation.restrict_reverted',
          'moderation.suspend_reverted',
          'moderation.ban_reverted',
          'moderation.remove_content_reverted',
          'moderation.channel_unlist_reverted',
          'moderation.channel_suspend_reverted',
          'moderation.legal_referral_reverted',
        ],
      },
      schema: {
        params: actionParamsSchema,
        body: reviewDecisionSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await moderation.revert(context.session.userId, params.actionId, body.note, meta(context));
        return ok;
      },
    }),
    defineRoute({
      ...staff,
      id: 'moderation.dismiss',
      method: 'POST',
      url: '/api/v1/moderation/cases/:caseId/dismiss',
      summary: 'Close a case without action',
      rateLimit: limits.staffWrite,
      audit: { kind: 'records', actions: ['moderation.case_dismissed'] },
      schema: { params: caseParamsSchema, body: dismissCaseSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await moderation.dismiss(context.session.userId, params.caseId, body, meta(context));
        return ok;
      },
    }),
    defineRoute({
      ...staff,
      id: 'moderation.appeals',
      method: 'GET',
      url: '/api/v1/moderation/appeals',
      summary: 'Open appeals',
      rateLimit: limits.staffRead,
      audit: readOnly,
      schema: { response: appealListSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        appeals: await moderation.openAppeals(context.session.userId),
      }),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.decide_appeal',
      method: 'POST',
      url: '/api/v1/moderation/appeals/:appealId/decision',
      summary: 'Uphold or overturn a decision (not by whoever took or approved it)',
      rateLimit: limits.staffWrite,
      audit: {
        kind: 'records',
        actions: ['moderation.appeal_upheld', 'moderation.appeal_overturned'],
      },
      schema: { params: appealParamsSchema, body: decideAppealSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await moderation.decideAppeal(
          context.session.userId,
          params.appealId,
          body.outcome,
          body.reason,
          meta(context),
        );
        return ok;
      },
    }),
    defineRoute({
      ...staffStepUp,
      id: 'moderation.legal_order',
      method: 'POST',
      url: '/api/v1/moderation/legal-orders',
      summary: 'Record a court or government order (legal team; 3-hour deadline)',
      rateLimit: limits.staffWrite,
      audit: { kind: 'records', actions: ['moderation.legal_order'] },
      schema: { body: legalOrderSchema, response: z.object({ caseId: z.string() }) },
      successStatus: 201,
      handler: ({ body }, context) =>
        moderation.legalOrder(context.session.userId, body, meta(context)),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.transparency',
      method: 'GET',
      url: '/api/v1/moderation/transparency',
      summary: 'Monthly compliance figures (counts only)',
      rateLimit: limits.staffRead,
      audit: readOnly,
      schema: { querystring: transparencyQuerySchema, response: transparencySchema },
      successStatus: 200,
      handler: ({ query }, context) => moderation.transparency(context.session.userId, query.month),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.blocklist',
      method: 'GET',
      url: '/api/v1/moderation/link-blocklist',
      summary: 'Blocked link hosts',
      rateLimit: limits.staffRead,
      audit: readOnly,
      schema: { response: blocklistSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        entries: await moderation.blocklist(context.session.userId),
      }),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.blocklist_add',
      method: 'POST',
      url: '/api/v1/moderation/link-blocklist',
      summary: 'Block a link host (warned in chats, refused in public posts)',
      rateLimit: limits.staffWrite,
      audit: { kind: 'records', actions: ['moderation.link_blocked'] },
      schema: { body: blocklistEntrySchema, response: okResponseSchema },
      successStatus: 201,
      handler: async ({ body }, context) => {
        await moderation.addBlockedHost(context.session.userId, body.host, body.category);
        return ok;
      },
    }),
    defineRoute({
      ...staff,
      id: 'moderation.blocklist_remove',
      method: 'DELETE',
      url: '/api/v1/moderation/link-blocklist/:host',
      summary: 'Unblock a link host',
      rateLimit: limits.staffWrite,
      audit: { kind: 'records', actions: ['moderation.link_unblocked'] },
      schema: { params: blocklistParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await moderation.removeBlockedHost(context.session.userId, params.host);
        return ok;
      },
    }),
    defineRoute({
      ...staffStepUp,
      id: 'moderation.abuse_hashes_import',
      method: 'POST',
      url: '/api/v1/moderation/abuse-hashes',
      summary: 'Import hashes of known child sexual abuse material (legal team)',
      rateLimit: limits.staffWrite,
      audit: { kind: 'records', actions: ['moderation.abuse_hashes_imported'] },
      bodyLimit: 1024 * 1024,
      schema: { body: csamHashImportSchema, response: csamHashStatsSchema },
      successStatus: 200,
      handler: async ({ body }, context) => ({
        count: await moderation.importAbuseHashes(context.session.userId, body.hashes, body.source),
      }),
    }),
    defineRoute({
      ...staff,
      id: 'moderation.abuse_hashes_count',
      method: 'GET',
      url: '/api/v1/moderation/abuse-hashes',
      summary: 'How many known-abuse hashes are loaded (legal team)',
      rateLimit: limits.staffRead,
      audit: readOnly,
      schema: { response: csamHashStatsSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        count: await moderation.abuseHashCount(context.session.userId),
      }),
    }),
  ];
}
