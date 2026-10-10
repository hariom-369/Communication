import {
  appealListSchema,
  blockedListSchema,
  blocklistSchema,
  caseDetailSchema,
  caseListSchema,
  csamHashStatsSchema,
  evidenceViewSchema,
  grievanceReceiptSchema,
  linkHashesSchema,
  linkPrefixesSchema,
  moderationKeySchema,
  myReportsSchema,
  okResponseSchema,
  reportReceiptSchema,
  staffMeSchema,
  standingSchema,
  transparencySchema,
  type createReportSchema,
} from '@tessera/validation';
import { z } from 'zod';

import { api } from './client.js';

const enc = encodeURIComponent;

/** Safety and moderation (docs/moderation.md); schemas are shared with the server. */
export const moderationEndpoints = {
  // ---- blocks ----
  blocked: () => api('GET', '/blocks', blockedListSchema),
  block: (userId: string) => api('POST', '/blocks', okResponseSchema, { userId }),
  unblock: (userId: string) => api('DELETE', `/blocks/${enc(userId)}`, okResponseSchema),

  // ---- reports ----
  moderationKey: () => api('GET', '/moderation/key', moderationKeySchema),
  report: (body: z.input<typeof createReportSchema>) =>
    api('POST', '/reports', reportReceiptSchema, body),
  myReports: () => api('GET', '/reports', myReportsSchema),

  // ---- account standing ----
  standing: () => api('GET', '/account/standing', standingSchema),
  appeal: (actionId: string, statement: string) =>
    api('POST', '/account/appeals', okResponseSchema, { actionId, statement }),
  grievance: (body: {
    kind: 'grievance' | 'ncii' | 'synthetic_media';
    contact: string;
    description: string;
    reference: string;
  }) => api('POST', '/grievances', grievanceReceiptSchema, body),

  // ---- link safety ----
  linkPrefixes: () => api('GET', '/link-safety/prefixes', linkPrefixesSchema),
  linkHashes: (prefix: string) =>
    api('GET', `/link-safety/hashes?prefix=${enc(prefix)}`, linkHashesSchema),

  // ---- staff ----
  staffMe: () => api('GET', '/moderation/me', staffMeSchema),
  cases: (query: { status: 'open' | 'actioned' | 'dismissed'; category?: string }) => {
    const params = new URLSearchParams({ status: query.status });
    if (query.category !== undefined) params.set('category', query.category);
    return api('GET', `/moderation/cases?${params.toString()}`, caseListSchema);
  },
  caseDetail: (caseId: string) => api('GET', `/moderation/cases/${enc(caseId)}`, caseDetailSchema),
  viewEvidence: (caseId: string, evidenceId: string) =>
    api(
      'POST',
      `/moderation/cases/${enc(caseId)}/evidence/${enc(evidenceId)}/view`,
      evidenceViewSchema,
      {},
    ),
  acknowledge: (caseId: string) =>
    api('POST', `/moderation/cases/${enc(caseId)}/acknowledge`, okResponseSchema, {}),
  note: (caseId: string, note: string) =>
    api('POST', `/moderation/cases/${enc(caseId)}/notes`, okResponseSchema, { note }),
  takeAction: (
    caseId: string,
    body: {
      action: string;
      reasonCode: string;
      restriction?: 'new_chats' | 'creation';
      durationHours?: number;
      note: string;
    },
  ) =>
    api(
      'POST',
      `/moderation/cases/${enc(caseId)}/actions`,
      z.object({ id: z.string(), status: z.enum(['active', 'pending_review']) }),
      body,
    ),
  approve: (actionId: string, note: string) =>
    api('POST', `/moderation/actions/${enc(actionId)}/approve`, okResponseSchema, { note }),
  reject: (actionId: string, note: string) =>
    api('POST', `/moderation/actions/${enc(actionId)}/reject`, okResponseSchema, { note }),
  revert: (actionId: string, note: string) =>
    api('POST', `/moderation/actions/${enc(actionId)}/revert`, okResponseSchema, { note }),
  dismiss: (caseId: string, reasonCode: string, note: string) =>
    api('POST', `/moderation/cases/${enc(caseId)}/dismiss`, okResponseSchema, { reasonCode, note }),
  appeals: () => api('GET', '/moderation/appeals', appealListSchema),
  decideAppeal: (appealId: string, outcome: 'upheld' | 'overturned', reason: string) =>
    api('POST', `/moderation/appeals/${enc(appealId)}/decision`, okResponseSchema, {
      outcome,
      reason,
    }),
  legalOrder: (body: {
    kind: 'court_order' | 'government_order';
    reference: string;
    description: string;
    subject: { kind: string; id: string; channelId?: string };
  }) => api('POST', '/moderation/legal-orders', z.object({ caseId: z.string() }), body),
  transparency: (month: string) =>
    api('GET', `/moderation/transparency?month=${enc(month)}`, transparencySchema),
  blocklist: () => api('GET', '/moderation/link-blocklist', blocklistSchema),
  addBlockedHost: (host: string, category: 'phishing' | 'malware' | 'scam' | 'csam') =>
    api('POST', '/moderation/link-blocklist', okResponseSchema, { host, category }),
  removeBlockedHost: (host: string) =>
    api('DELETE', `/moderation/link-blocklist/${enc(host)}`, okResponseSchema),
  importAbuseHashes: (hashes: string[], source: string) =>
    api('POST', '/moderation/abuse-hashes', csamHashStatsSchema, { hashes, source }),
  abuseHashCount: () => api('GET', '/moderation/abuse-hashes', csamHashStatsSchema),
};
