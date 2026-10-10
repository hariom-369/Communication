import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Notifications (docs/notifications.md, ADR-048). Push messages carry no content: they only tell
 * a device which conversation (or channel) has something new. The device fetches the ciphertext
 * and decrypts it itself; what the notification shows is a setting kept on the device.
 */

/** Messages in one conversation within this window become one push. */
export const PUSH_COALESCE_SECONDS = 5;
/** At most one push per conversation (or channel) and person in this interval. */
export const PUSH_MIN_INTERVAL_SECONDS = 10;
/** Every push payload is padded to this many bytes, so its size says nothing about its kind. */
export const PUSH_PAYLOAD_BYTES = 128;
export const MAX_PUSH_ENDPOINT_LENGTH = 1024;

const base64url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => Math.floor((value.length * 3) / 4) === bytes, {
      message: `Must be ${bytes} bytes (base64url).`,
    });

/** What the browser's PushManager returns (`subscription.toJSON()`), bound to this device. */
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(MAX_PUSH_ENDPOINT_LENGTH),
  keys: z.strictObject({
    /** Uncompressed P-256 point (RFC 8291). */
    p256dh: base64url(65),
    /** Authentication secret (RFC 8291). */
    auth: base64url(16),
  }),
  /** This browser's encryption device. */
  deviceId: idSchema,
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const removePushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(MAX_PUSH_ENDPOINT_LENGTH),
});

export const notificationConfigSchema = z.object({
  /** False when the server has no push (VAPID) keys configured. */
  pushAvailable: z.boolean(),
  /** VAPID application server key (base64url), for `pushManager.subscribe`. */
  vapidPublicKey: z.string().nullable(),
  /** Whether this session has a push subscription registered. */
  subscribed: z.boolean(),
});

/** Minutes after local midnight. */
const minuteOfDay = z.number().int().min(0).max(1439);

const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown time zone.' },
  );

export const quietHoursSchema = z
  .strictObject({
    start: minuteOfDay,
    end: minuteOfDay,
    timeZone: timeZoneSchema,
    /** One-to-one calls still ring during quiet hours. */
    allowCalls: z.boolean(),
  })
  .refine((quiet) => quiet.start !== quiet.end, {
    message: 'Quiet hours must start and end at different times.',
    path: ['end'],
  });
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** Server-side preferences: they decide whether a push is sent at all. */
export const notificationPreferencesSchema = z.strictObject({
  messages: z.boolean(),
  calls: z.boolean(),
  channelPosts: z.boolean(),
  quietHours: quietHoursSchema.nullable(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  messages: true,
  calls: true,
  channelPosts: true,
  quietHours: null,
};

export const conversationMuteParamsSchema = z.strictObject({ conversationId: idSchema });

export const muteConversationSchema = z.strictObject({
  /** Muted until this time; null mutes until unmuted. */
  until: z.iso.datetime({ offset: true }).nullable(),
});

export const conversationMuteSchema = z.object({
  conversationId: z.string(),
  until: z.string().nullable(),
});
export type ConversationMute = z.infer<typeof conversationMuteSchema>;

export const conversationMutesSchema = z.object({ mutes: z.array(conversationMuteSchema) });

/** Account security alerts (docs/notifications.md §4): shown in the app on every device. */
export const securityAlertSchema = z.object({
  id: z.string(),
  headline: z.string(),
  details: z.array(z.string()),
  createdAt: z.string(),
  read: z.boolean(),
});
export type SecurityAlert = z.infer<typeof securityAlertSchema>;

export const securityAlertsSchema = z.object({
  alerts: z.array(securityAlertSchema),
  unread: z.number().int(),
});

export const markAlertsReadSchema = z.strictObject({
  /** Marks this alert and every older one as read. */
  upTo: idSchema,
});

export const channelNotificationsSchema = z.strictObject({ enabled: z.boolean() });

/**
 * The decrypted push payload the service worker receives (RFC 8291 encrypts it to the browser).
 * `p` is padding only.
 */
const pushId = z.string().regex(/^[0-9a-f-]{36}$/);

export const pushPayloadSchema = z.discriminatedUnion('t', [
  /** New messages in a conversation: fetch and decrypt them. */
  z.object({ t: z.literal('sync'), c: pushId, p: z.string().optional() }),
  /** A call is ringing in a conversation. */
  z.object({ t: z.literal('call'), c: pushId, k: pushId, p: z.string().optional() }),
  /** A channel this person follows with notifications on published a post. */
  z.object({ t: z.literal('channel'), c: pushId, p: z.string().optional() }),
  /** A new account security alert. */
  z.object({ t: z.literal('alert'), p: z.string().optional() }),
]);
export type PushPayload = z.infer<typeof pushPayloadSchema>;
