import {
  adminDashboardSchema,
  adminFlagListSchema,
  adminKeyOptionsSchema,
  adminListSchema,
  adminMeSchema,
  adminOidcStartSchema,
  adminSessionStateSchema,
  adminUserDetailSchema,
  adminUserSummarySchema,
  approvalListSchema,
  approvalSchema,
  auditPageSchema,
  healthSchema,
  okResponseSchema,
  securityHotspotsSchema,
  signupAnalyticsSchema,
  staffRoleListSchema,
  ticketListSchema,
  ticketSchema,
} from '@tessera/validation';
import type { approvalPayloadSchema } from '@tessera/validation';
import { z } from 'zod';

import { adminApi } from './api.js';

/** The admin API (services/api `admin-server`, routes under /admin/v1). */

const revokedSchema = z.object({ revoked: z.number().int() });
const enc = encodeURIComponent;

/** A change request as the form builds it (ids are checked by the API). */
export type ApprovalPayload = z.input<typeof approvalPayloadSchema>;
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export interface AuditFilter {
  readonly action?: string;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly before?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '',
  );
  return entries.length === 0
    ? ''
    : `?${entries.map(([key, value]) => `${key}=${enc(String(value))}`).join('&')}`;
}

export const endpoints = {
  // sign-in
  oidcStart: () => adminApi('POST', '/auth/oidc/start', adminOidcStartSchema, {}),
  oidcCallback: (code: string, state: string) =>
    adminApi('POST', '/auth/oidc/callback', adminSessionStateSchema, { code, state }),
  keyOptions: () => adminApi('POST', '/auth/key/options', adminKeyOptionsSchema, {}),
  keyVerify: (flowId: string, response: Record<string, unknown>, name?: string) =>
    adminApi('POST', '/auth/key/verify', adminSessionStateSchema, {
      flowId,
      response,
      ...(name === undefined ? {} : { name }),
    }),
  reauthOptions: () => adminApi('POST', '/auth/reauth/options', adminKeyOptionsSchema, {}),
  reauthVerify: (flowId: string, response: Record<string, unknown>) =>
    adminApi('POST', '/auth/reauth/verify', okResponseSchema, { flowId, response }),
  logout: () => adminApi('POST', '/auth/logout', okResponseSchema, {}),
  me: () => adminApi('GET', '/me', adminMeSchema),

  // overview
  dashboard: () => adminApi('GET', '/dashboard', adminDashboardSchema),
  signups: (days: number) =>
    adminApi('GET', `/analytics/signups${query({ days })}`, signupAnalyticsSchema),
  health: () => adminApi('GET', '/health', healthSchema),
  hotspots: (hours: number) =>
    adminApi('GET', `/security/hotspots${query({ hours })}`, securityHotspotsSchema),

  // people
  lookup: (identifier: string, purpose: string) =>
    adminApi('POST', '/users/lookup', adminUserSummarySchema, { identifier, purpose }),
  userDetail: (userId: string, purpose: string) =>
    adminApi('GET', `/users/${enc(userId)}${query({ purpose })}`, adminUserDetailSchema),
  revokeSessions: (userId: string, purpose: string, sessionId?: string) =>
    adminApi('POST', `/users/${enc(userId)}/sessions/revoke`, revokedSchema, {
      purpose,
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  resendVerification: (userId: string, purpose: string) =>
    adminApi('POST', `/users/${enc(userId)}/resend-verification`, okResponseSchema, { purpose }),

  // tickets
  createTicket: (input: { reference: string; identifier: string; reason: string }) =>
    adminApi('POST', '/tickets', ticketSchema, input),
  tickets: (status: 'open' | 'closed') =>
    adminApi('GET', `/tickets${query({ status })}`, ticketListSchema),
  closeTicket: (ticketId: string) =>
    adminApi('POST', `/tickets/${enc(ticketId)}/close`, okResponseSchema, {}),

  // four eyes
  approvals: (status: ApprovalStatus) =>
    adminApi('GET', `/approvals${query({ status })}`, approvalListSchema),
  requestApproval: (payload: ApprovalPayload, reason: string) =>
    adminApi('POST', '/approvals', approvalSchema, { payload, reason }),
  approve: (approvalId: string, note: string) =>
    adminApi('POST', `/approvals/${enc(approvalId)}/approve`, approvalSchema, { note }),
  reject: (approvalId: string, note: string) =>
    adminApi('POST', `/approvals/${enc(approvalId)}/reject`, okResponseSchema, { note }),
  cancel: (approvalId: string) =>
    adminApi('POST', `/approvals/${enc(approvalId)}/cancel`, okResponseSchema, {}),

  // admins, staff, flags, audit
  admins: () => adminApi('GET', '/admins', adminListSchema),
  disableAdmin: (adminId: string) =>
    adminApi('POST', `/admins/${enc(adminId)}/disable`, okResponseSchema, {}),
  staff: () => adminApi('GET', '/staff-roles', staffRoleListSchema),
  revokeStaff: (userId: string, role: 'moderator' | 'senior_moderator' | 'legal') =>
    adminApi('POST', '/staff-roles/revoke', okResponseSchema, { userId, role }),
  flags: () => adminApi('GET', '/flags', adminFlagListSchema),
  audit: (filter: AuditFilter) =>
    adminApi('GET', `/audit${query({ ...filter, limit: 50 })}`, auditPageSchema),
};
