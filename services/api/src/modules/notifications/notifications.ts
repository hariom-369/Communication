import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  CALL_RING_SECONDS,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type ConversationMute,
  type NotificationPreferences,
  type PushSubscriptionInput,
  type QuietHours,
  type SecurityAlert,
} from '@tessera/validation';
import type { Redis } from 'ioredis';
import type { Kysely, Selectable } from 'kysely';

import type { Database, PushSubscriptionsTable } from '../../db/schema.js';
import type { RealtimePublisher } from '../../platform/realtime-publisher.js';

import type { PushMessage, PushSender } from './push.js';
import type { NotifyQueue, QueueEntry } from './queue.js';

/**
 * Notifications (docs/notifications.md, ADR-048).
 *
 * The server decides only *whether* to wake a device: a person's preferences, muted
 * conversations, quiet hours, and whether the device is already connected. Pushes name the
 * conversation, channel or call and nothing else; the device fetches the ciphertext, decrypts it
 * and decides what the notification shows. Message content never reaches this module.
 */

export interface NotificationConversations {
  /** Whether the user is (still) a member of the conversation. */
  isMember(conversationId: string, userId: string): Promise<boolean>;
}

export interface NotificationChannels {
  /** Subscribers with post notifications on, in user id order, after `after`. */
  notifiedSubscribers(channelId: string, after: string | null, limit: number): Promise<string[]>;
  isNotifiedSubscriber(channelId: string, userId: string): Promise<boolean>;
}

export interface NotificationSessions {
  /** The ids among `sessionIds` that are still signed in. */
  activeSessionIds(sessionIds: readonly string[]): Promise<Set<string>>;
}

export interface NotificationDevices {
  isActiveDevice(userId: string, deviceId: string): Promise<boolean>;
  activeDeviceIds(deviceIds: readonly string[]): Promise<Set<string>>;
}

export interface NotificationsConfig {
  readonly keyPrefix: string;
  readonly alertRetentionDays: number;
}

type SubscriptionRow = Selectable<PushSubscriptionsTable>;

/** Undelivered message pushes are pointless after an hour (the device syncs on open anyway). */
const MESSAGE_TTL_SECONDS = 3600;
const ALERT_TTL_SECONDS = 24 * 3600;
const FANOUT_BATCH = 1000;
const DRAIN_BATCH = 200;
const MAX_FAILURES = 10;
const ALERT_PAGE = 50;

/** Minutes after local midnight in `timeZone`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** Quiet hours may cross midnight (start > end). */
export function inQuietHours(quiet: QuietHours | null, now: Date): boolean {
  if (quiet === null) return false;
  const minutes = localMinutes(now, quiet.timeZone);
  return quiet.start < quiet.end
    ? minutes >= quiet.start && minutes < quiet.end
    : minutes >= quiet.start || minutes < quiet.end;
}

export class NotificationsService {
  readonly #db: Kysely<Database>;
  readonly #valkey: Redis;
  readonly #queue: NotifyQueue;
  readonly #push: PushSender | null;
  readonly #publisher: RealtimePublisher;
  readonly #conversations: NotificationConversations;
  readonly #sessions: NotificationSessions;
  readonly #devices: NotificationDevices;
  readonly #config: NotificationsConfig;
  readonly #logger: Logger;
  #channels: NotificationChannels | null = null;

  constructor(options: {
    db: Kysely<Database>;
    valkey: Redis;
    queue: NotifyQueue;
    push: PushSender | null;
    publisher: RealtimePublisher;
    conversations: NotificationConversations;
    sessions: NotificationSessions;
    devices: NotificationDevices;
    config: NotificationsConfig;
    logger: Logger;
  }) {
    this.#db = options.db;
    this.#valkey = options.valkey;
    this.#queue = options.queue;
    this.#push = options.push;
    this.#publisher = options.publisher;
    this.#conversations = options.conversations;
    this.#sessions = options.sessions;
    this.#devices = options.devices;
    this.#config = options.config;
    this.#logger = options.logger;
  }

  useChannels(channels: NotificationChannels): void {
    this.#channels = channels;
  }

  // ---- subscriptions ---------------------------------------------------------------------------

  async config(
    userId: string,
    sessionId: string,
  ): Promise<{ pushAvailable: boolean; vapidPublicKey: string | null; subscribed: boolean }> {
    const row = await this.#db
      .selectFrom('push_subscriptions')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return {
      pushAvailable: this.#push !== null,
      vapidPublicKey: this.#push?.publicKey ?? null,
      subscribed: row !== undefined,
    };
  }

  /** Registers this browser session's push endpoint (replacing any earlier one). */
  async subscribe(userId: string, sessionId: string, input: PushSubscriptionInput): Promise<void> {
    if (this.#push === null)
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Push notifications are not available on this server.',
      });
    if (!this.#push.acceptsEndpoint(input.endpoint))
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This push service is not supported.',
      });
    if (!(await this.#devices.isActiveDevice(userId, input.deviceId)))
      throw new AppError('FORBIDDEN', { detail: 'This device is not registered for encryption.' });
    await this.#db.transaction().execute(async (trx) => {
      // An endpoint belongs to one browser profile; whoever registers it last owns it.
      await trx
        .deleteFrom('push_subscriptions')
        .where((eb) =>
          eb.or([eb('session_id', '=', sessionId), eb('endpoint', '=', input.endpoint)]),
        )
        .execute();
      await trx
        .insertInto('push_subscriptions')
        .values({
          id: newId(),
          user_id: userId,
          session_id: sessionId,
          device_id: input.deviceId,
          endpoint: input.endpoint,
          p256dh: Buffer.from(input.keys.p256dh, 'base64url'),
          auth: Buffer.from(input.keys.auth, 'base64url'),
        })
        .execute();
    });
  }

  async unsubscribe(userId: string, sessionId: string, endpoint: string | null): Promise<void> {
    let query = this.#db.deleteFrom('push_subscriptions').where('user_id', '=', userId);
    query =
      endpoint === null
        ? query.where('session_id', '=', sessionId)
        : query.where((eb) =>
            eb.or([eb('endpoint', '=', endpoint), eb('session_id', '=', sessionId)]),
          );
    await query.execute();
  }

  /** A privilege change replaced the session: the browser keeps its push subscription. */
  async sessionRotated(from: string, to: string): Promise<void> {
    try {
      await this.#db
        .updateTable('push_subscriptions')
        .set({ session_id: to })
        .where('session_id', '=', from)
        .execute();
    } catch (error) {
      this.#logger.warn('notifications.rotate_failed', this.#logger.errorFields(error));
    }
  }

  // ---- preferences and mutes -------------------------------------------------------------------

  async preferences(userId: string): Promise<NotificationPreferences> {
    const row = await this.#db
      .selectFrom('notification_preferences')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return DEFAULT_NOTIFICATION_PREFERENCES;
    return {
      messages: row.messages,
      calls: row.calls,
      channelPosts: row.channel_posts,
      quietHours:
        row.quiet_start === null || row.quiet_end === null || row.quiet_time_zone === null
          ? null
          : {
              start: row.quiet_start,
              end: row.quiet_end,
              timeZone: row.quiet_time_zone,
              allowCalls: row.quiet_allow_calls,
            },
    };
  }

  async setPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const quiet = preferences.quietHours;
    const values = {
      messages: preferences.messages,
      calls: preferences.calls,
      channel_posts: preferences.channelPosts,
      quiet_start: quiet?.start ?? null,
      quiet_end: quiet?.end ?? null,
      quiet_time_zone: quiet?.timeZone ?? null,
      quiet_allow_calls: quiet?.allowCalls ?? true,
      updated_at: new Date(),
    };
    await this.#db
      .insertInto('notification_preferences')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    this.#publisher.publish([userId], { type: 'notifications', what: 'settings' });
    return this.preferences(userId);
  }

  async mutes(userId: string): Promise<ConversationMute[]> {
    const rows = await this.#db
      .selectFrom('conversation_mutes')
      .select(['conversation_id', 'muted_until'])
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('muted_until', 'is', null), eb('muted_until', '>', new Date())]))
      .execute();
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      until: row.muted_until?.toISOString() ?? null,
    }));
  }

  async mute(userId: string, conversationId: string, until: string | null): Promise<void> {
    if (!(await this.#conversations.isMember(conversationId, userId)))
      throw new AppError('NOT_FOUND');
    const mutedUntil = until === null ? null : new Date(until);
    if (mutedUntil !== null && mutedUntil.getTime() <= Date.now())
      throw new AppError('VALIDATION_FAILED', { detail: 'Choose a time in the future.' });
    await this.#db
      .insertInto('conversation_mutes')
      .values({ user_id: userId, conversation_id: conversationId, muted_until: mutedUntil })
      .onConflict((oc) =>
        oc.columns(['user_id', 'conversation_id']).doUpdateSet({ muted_until: mutedUntil }),
      )
      .execute();
    this.#publisher.publish([userId], { type: 'notifications', what: 'settings' });
  }

  async unmute(userId: string, conversationId: string): Promise<void> {
    await this.#db
      .deleteFrom('conversation_mutes')
      .where('user_id', '=', userId)
      .where('conversation_id', '=', conversationId)
      .execute();
    this.#publisher.publish([userId], { type: 'notifications', what: 'settings' });
  }

  // ---- security alerts (docs/notifications.md §4) ----------------------------------------------

  async alerts(userId: string): Promise<{ alerts: SecurityAlert[]; unread: number }> {
    const [rows, unread] = await Promise.all([
      this.#db
        .selectFrom('security_alerts')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('id', 'desc')
        .limit(ALERT_PAGE)
        .execute(),
      this.#db
        .selectFrom('security_alerts')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      alerts: rows.map((row) => ({
        id: row.id,
        headline: row.headline,
        details: row.details,
        createdAt: row.created_at.toISOString(),
        read: row.read_at !== null,
      })),
      unread: Number(unread.count),
    };
  }

  async markAlertsRead(userId: string, upTo: string): Promise<void> {
    await this.#db
      .updateTable('security_alerts')
      .set({ read_at: new Date() })
      .where('user_id', '=', userId)
      .where('id', '<=', upTo)
      .where('read_at', 'is', null)
      .execute();
    this.#publisher.publish([userId], { type: 'notifications', what: 'alerts' });
  }

  /**
   * Records a security alert for every device of the user: in the app (realtime) and as a push
   * to devices that are not connected. Cannot be turned off; ignores mutes and quiet hours.
   * Best-effort: failures are logged, never raised into the security action that caused them.
   */
  async securityAlert(
    userId: string,
    headline: string,
    details: readonly string[] = [],
  ): Promise<void> {
    try {
      await this.#db
        .insertInto('security_alerts')
        .values({
          id: newId(),
          user_id: userId,
          headline: headline.slice(0, 200),
          details: JSON.stringify(details.map((line) => line.slice(0, 300)).slice(0, 10)),
        })
        .execute();
      this.#publisher.publish([userId], { type: 'notifications', what: 'alerts' });
      await this.#deliver(
        await this.#subscriptions([userId]),
        { payload: { t: 'alert' }, ttlSeconds: ALERT_TTL_SECONDS, urgency: 'high' },
        { skipConnected: true },
      );
    } catch (error) {
      this.#logger.error('notifications.alert_failed', {
        userId,
        ...this.#logger.errorFields(error),
      });
    }
  }

  // ---- events from other modules ---------------------------------------------------------------

  /** A new end-to-end encrypted message: wake the other members' devices (coalesced). */
  async messageStored(
    conversationId: string,
    senderUserId: string,
    memberIds: readonly string[],
  ): Promise<void> {
    if (this.#push === null) return;
    const entries: QueueEntry[] = memberIds
      .filter((id) => id !== senderUserId)
      .map((userId) => ({ kind: 'conversation', userId, id: conversationId }));
    await this.#queue.enqueue(entries).catch((error: unknown) => {
      this.#logger.warn('notifications.enqueue_failed', this.#logger.errorFields(error));
    });
  }

  /** A call started ringing: push right away (not coalesced), high urgency, short TTL. */
  async callRinging(
    conversationId: string,
    callId: string,
    recipientIds: readonly string[],
    direct: boolean,
  ): Promise<void> {
    if (this.#push === null || recipientIds.length === 0) return;
    try {
      const now = new Date();
      const recipients: string[] = [];
      for (const userId of recipientIds) {
        const preferences = await this.preferences(userId);
        if (!preferences.calls) continue;
        if (
          inQuietHours(preferences.quietHours, now) &&
          !(direct && preferences.quietHours?.allowCalls)
        )
          continue;
        // Muting a group silences its calls too; a one-to-one call always rings.
        if (!direct && (await this.#muted(userId, conversationId, now))) continue;
        recipients.push(userId);
      }
      await this.#deliver(
        await this.#subscriptions(recipients),
        {
          payload: { t: 'call', c: conversationId, k: callId },
          ttlSeconds: CALL_RING_SECONDS,
          urgency: 'high',
        },
        { skipConnected: true },
      );
    } catch (error) {
      this.#logger.warn('notifications.call_push_failed', this.#logger.errorFields(error));
    }
  }

  /** A channel published a post: queue its opted-in subscribers in the background. */
  async channelPost(channelId: string): Promise<void> {
    if (this.#push === null) return;
    await this.#queue.pushFanout({ channelId, after: null }).catch((error: unknown) => {
      this.#logger.warn('notifications.enqueue_failed', this.#logger.errorFields(error));
    });
  }

  // ---- background work -------------------------------------------------------------------------

  /** One pass of the delivery worker (singleton). Returns the number of queue entries handled. */
  async drain(now = new Date()): Promise<number> {
    if (this.#push === null) return 0;
    const job = await this.#queue.popFanout();
    if (job !== null && this.#channels !== null) {
      const subscribers = await this.#channels.notifiedSubscribers(
        job.channelId,
        job.after,
        FANOUT_BATCH,
      );
      await this.#queue.enqueue(
        subscribers.map((userId) => ({ kind: 'channel', userId, id: job.channelId })),
        now.getTime(),
      );
      const last = subscribers.at(-1);
      if (subscribers.length === FANOUT_BATCH && last !== undefined)
        await this.#queue.pushFanout({ channelId: job.channelId, after: last });
    }
    const entries = await this.#queue.claimDue(now.getTime(), DRAIN_BATCH);
    for (const entry of entries) {
      try {
        await this.#deliverEntry(entry, now);
      } catch (error) {
        this.#logger.warn('notifications.delivery_failed', this.#logger.errorFields(error));
      }
    }
    return entries.length;
  }

  /** Housekeeping: old alerts, expired mutes, subscriptions of ended sessions or devices. */
  /** Seconds the oldest due push has waited (the queue-age SLO, docs/observability.md §3). */
  async oldestDueSeconds(now = new Date()): Promise<number> {
    return (await this.#queue.oldestDueMs(now.getTime())) / 1000;
  }

  async sweep(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.#config.alertRetentionDays * 24 * 3600 * 1000);
    await this.#db.deleteFrom('security_alerts').where('created_at', '<', cutoff).execute();
    await this.#db.deleteFrom('conversation_mutes').where('muted_until', '<', now).execute();
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = await this.#db
        .selectFrom('push_subscriptions')
        .select(['id', 'session_id', 'device_id'])
        .where('id', '>', after)
        .orderBy('id')
        .limit(500)
        .execute();
      if (rows.length === 0) break;
      const [sessions, devices] = await Promise.all([
        this.#sessions.activeSessionIds(rows.map((row) => row.session_id)),
        this.#devices.activeDeviceIds(rows.map((row) => row.device_id)),
      ]);
      const stale = rows
        .filter((row) => !sessions.has(row.session_id) || !devices.has(row.device_id))
        .map((row) => row.id);
      if (stale.length > 0)
        await this.#db.deleteFrom('push_subscriptions').where('id', 'in', stale).execute();
      after = rows.at(-1)?.id ?? after;
    }
  }

  async #deliverEntry(entry: QueueEntry, now: Date): Promise<void> {
    const preferences = await this.preferences(entry.userId);
    if (inQuietHours(preferences.quietHours, now)) return;
    let message: PushMessage;
    if (entry.kind === 'conversation') {
      if (!preferences.messages) return;
      if (await this.#muted(entry.userId, entry.id, now)) return;
      if (!(await this.#conversations.isMember(entry.id, entry.userId))) return;
      message = {
        payload: { t: 'sync', c: entry.id },
        ttlSeconds: MESSAGE_TTL_SECONDS,
        urgency: 'normal',
        topicKey: entry.id,
      };
    } else {
      if (!preferences.channelPosts || this.#channels === null) return;
      if (!(await this.#channels.isNotifiedSubscriber(entry.id, entry.userId))) return;
      message = {
        payload: { t: 'channel', c: entry.id },
        ttlSeconds: MESSAGE_TTL_SECONDS,
        urgency: 'normal',
        topicKey: entry.id,
      };
    }
    const sent = await this.#deliver(await this.#subscriptions([entry.userId]), message, {
      skipConnected: true,
    });
    if (sent > 0) await this.#queue.markSent(entry);
  }

  async #muted(userId: string, conversationId: string, now: Date): Promise<boolean> {
    const row = await this.#db
      .selectFrom('conversation_mutes')
      .select('muted_until')
      .where('user_id', '=', userId)
      .where('conversation_id', '=', conversationId)
      .executeTakeFirst();
    return row !== undefined && (row.muted_until === null || row.muted_until > now);
  }

  /** Subscriptions of signed-in sessions on active devices. */
  async #subscriptions(userIds: readonly string[]): Promise<SubscriptionRow[]> {
    if (userIds.length === 0) return [];
    const rows = await this.#db
      .selectFrom('push_subscriptions')
      .selectAll()
      .where('user_id', 'in', [...new Set(userIds)])
      .execute();
    if (rows.length === 0) return [];
    const [sessions, devices] = await Promise.all([
      this.#sessions.activeSessionIds(rows.map((row) => row.session_id)),
      this.#devices.activeDeviceIds(rows.map((row) => row.device_id)),
    ]);
    return rows.filter((row) => sessions.has(row.session_id) && devices.has(row.device_id));
  }

  /** Sends to each subscription; returns how many accepted the push. */
  async #deliver(
    rows: readonly SubscriptionRow[],
    message: PushMessage,
    options: { skipConnected: boolean },
  ): Promise<number> {
    if (this.#push === null || rows.length === 0) return 0;
    const connected = options.skipConnected
      ? await this.#connectedSessions(rows.map((row) => row.session_id))
      : new Set<string>();
    let sent = 0;
    for (const row of rows) {
      if (connected.has(row.session_id)) continue; // the app is open: realtime delivers it
      const outcome = await this.#push.send(row, message);
      if (outcome === 'sent') {
        sent += 1;
        await this.#db
          .updateTable('push_subscriptions')
          .set({ last_success_at: new Date(), failures: 0 })
          .where('id', '=', row.id)
          .execute();
      } else if (outcome === 'gone' || row.failures + 1 >= MAX_FAILURES) {
        await this.#db.deleteFrom('push_subscriptions').where('id', '=', row.id).execute();
      } else {
        await this.#db
          .updateTable('push_subscriptions')
          .set({ failures: row.failures + 1 })
          .where('id', '=', row.id)
          .execute();
      }
    }
    return sent;
  }

  /** Sessions with an open realtime connection (maintained by the realtime gateway). */
  async #connectedSessions(sessionIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return new Set();
    const values = await this.#valkey.mget(
      ids.map((id) => `${this.#config.keyPrefix}:presence:session:${id}`),
    );
    return new Set(ids.filter((_, index) => values[index] !== null));
  }
}
