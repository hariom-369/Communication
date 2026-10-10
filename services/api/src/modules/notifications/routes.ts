import {
  conversationMuteParamsSchema,
  conversationMutesSchema,
  markAlertsReadSchema,
  muteConversationSchema,
  notificationConfigSchema,
  notificationPreferencesSchema,
  okResponseSchema,
  pushSubscriptionSchema,
  securityAlertsSchema,
} from '@tessera/validation';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { NotificationsService } from './notifications.js';

export interface NotificationsModuleDeps {
  readonly notifications: NotificationsService;
}

const policy = (name: string, limit: number, periodMs: number, burst: number): RateLimitPolicy => ({
  name: `notifications.${name}`,
  limit,
  periodMs,
  burst,
  onStoreFailure: 'open',
});

const limits = {
  read: policy('read', 600, 60_000, 120),
  write: policy('write', 300, 3_600_000, 60),
} satisfies Record<string, RateLimitPolicy>;

const common = {
  tags: ['notifications'],
  auth: { kind: 'session' },
  authorize: ownAccount,
} as const;
const readOnly = { kind: 'none', reason: 'Read-only' } as const;
const ownSettings = {
  kind: 'none',
  reason: "The person's own notification settings; no effect on security or other people",
} as const;

export function notificationRoutes(deps: NotificationsModuleDeps): RouteDefinition[] {
  const { notifications } = deps;
  return [
    defineRoute({
      ...common,
      id: 'notifications.config',
      method: 'GET',
      url: '/api/v1/notifications/config',
      summary: 'Whether push is available, the VAPID key, and whether this session subscribed',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: notificationConfigSchema },
      successStatus: 200,
      handler: (_request, context) =>
        notifications.config(context.session.userId, context.session.id),
    }),
    defineRoute({
      ...common,
      id: 'notifications.subscribe',
      method: 'PUT',
      url: '/api/v1/notifications/push-subscription',
      summary: "Register this browser session's push endpoint (content-free pushes only)",
      rateLimit: limits.write,
      audit: {
        kind: 'none',
        reason: 'Delivery address bound to this session and device; deleted when either ends',
      },
      schema: { body: pushSubscriptionSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await notifications.subscribe(context.session.userId, context.session.id, body);
        return { ok: true as const };
      },
    }),
    defineRoute({
      ...common,
      id: 'notifications.unsubscribe',
      method: 'DELETE',
      url: '/api/v1/notifications/push-subscription',
      summary: "Remove this browser session's push endpoint",
      rateLimit: limits.write,
      audit: { kind: 'none', reason: 'Removes a delivery address of this session' },
      schema: { response: okResponseSchema },
      successStatus: 200,
      handler: async (_request, context) => {
        await notifications.unsubscribe(context.session.userId, context.session.id, null);
        return { ok: true as const };
      },
    }),
    defineRoute({
      ...common,
      id: 'notifications.preferences_get',
      method: 'GET',
      url: '/api/v1/notifications/preferences',
      summary: 'Which events may wake your devices, and quiet hours',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: notificationPreferencesSchema },
      successStatus: 200,
      handler: (_request, context) => notifications.preferences(context.session.userId),
    }),
    defineRoute({
      ...common,
      id: 'notifications.preferences_update',
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      summary: 'Change which events may wake your devices, and quiet hours',
      rateLimit: limits.write,
      audit: ownSettings,
      schema: { body: notificationPreferencesSchema, response: notificationPreferencesSchema },
      successStatus: 200,
      handler: ({ body }, context) => notifications.setPreferences(context.session.userId, body),
    }),
    defineRoute({
      ...common,
      id: 'notifications.mutes',
      method: 'GET',
      url: '/api/v1/notifications/mutes',
      summary: 'Your muted conversations',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: conversationMutesSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        mutes: await notifications.mutes(context.session.userId),
      }),
    }),
    defineRoute({
      ...common,
      id: 'notifications.mute',
      method: 'PUT',
      url: '/api/v1/conversations/:conversationId/mute',
      summary: 'Mute a conversation (until a time, or until unmuted)',
      rateLimit: limits.write,
      audit: ownSettings,
      schema: {
        params: conversationMuteParamsSchema,
        body: muteConversationSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await notifications.mute(context.session.userId, params.conversationId, body.until);
        return { ok: true as const };
      },
    }),
    defineRoute({
      ...common,
      id: 'notifications.unmute',
      method: 'DELETE',
      url: '/api/v1/conversations/:conversationId/mute',
      summary: 'Unmute a conversation',
      rateLimit: limits.write,
      audit: ownSettings,
      schema: { params: conversationMuteParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await notifications.unmute(context.session.userId, params.conversationId);
        return { ok: true as const };
      },
    }),
    defineRoute({
      ...common,
      id: 'notifications.alerts',
      method: 'GET',
      url: '/api/v1/security-alerts',
      summary: 'Recent account security alerts',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: securityAlertsSchema },
      successStatus: 200,
      handler: (_request, context) => notifications.alerts(context.session.userId),
    }),
    defineRoute({
      ...common,
      id: 'notifications.alerts_read',
      method: 'POST',
      url: '/api/v1/security-alerts/read',
      summary: 'Mark security alerts as read (up to and including one)',
      rateLimit: limits.write,
      audit: { kind: 'none', reason: 'Read markers on the person’s own alerts' },
      schema: { body: markAlertsReadSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await notifications.markAlertsRead(context.session.userId, body.upTo);
        return { ok: true as const };
      },
    }),
  ];
}
