import { createHash, randomBytes, randomInt } from 'node:crypto';

import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  ALL_CHANNEL_PERMISSIONS,
  CHANNEL_PERMISSIONS,
  OWNERSHIP_COOLDOWN_HOURS,
  type ChannelPermission,
  type channelAdminListSchema,
  type channelAnalyticsSchema,
  type channelInvitePreviewSchema,
  type channelLinkListSchema,
  type channelListSchema,
  type channelPostSchema,
  type channelSchema,
  type commentListSchema,
  type commentSchema,
  type createChannelLinkSchema,
  type createChannelSchema,
  type createPostSchema,
  type createdChannelLinkSchema,
  type pollVotersSchema,
  type postListSchema,
  type updateChannelSchema,
} from '@tessera/validation';
import type { Redis } from 'ioredis';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { z } from 'zod';

import type { ChannelPostStatus, Database } from '../../db/schema.js';
import type { AuditLog } from '../audit/index.js';

import type { LinkPreviewer } from './previews.js';

/**
 * Broadcast channels (docs/channels.md, ADR-012, ADR-046). Server-protected, NOT end-to-end
 * encrypted.
 *
 * Scale rules:
 * - publishing is one insert (plus one row update on the channel); subscribers fetch feeds
 *   (fan-out on read) — nothing is written per subscriber when a post goes out;
 * - subscriber counts are sharded counters, never `count(*)`;
 * - views are counted with Valkey HyperLogLogs per post per day and rolled up; no per-viewer
 *   history is stored or shown to channel owners.
 */

export interface ChannelDirectory {
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
  discoverableByUsername(username: string): Promise<{ id: string; username: string } | null>;
}

type Executor = Kysely<Database> | Transaction<Database>;
type Post = z.infer<typeof channelPostSchema>;

const SHARDS = 16;
const MAX_OWNED = 20;
const DIRECTORY_LIMIT = 30;
const MAX_SCHEDULE_DAYS = 90;
const MIN_SCHEDULE_MS = 15_000;
const VIEW_KEY_TTL_SECONDS = 40 * 24 * 3600;
const ANALYTICS_DAYS = 30;
const DAY_MS = 24 * 3_600_000;

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function encodeCursor(time: Date, id: string): string {
  return Buffer.from(`${time.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { time: Date; id: string } {
  const [time, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const parsed = new Date(time ?? '');
  if (id === undefined || Number.isNaN(parsed.getTime()) || !/^[0-9a-f-]{36}$/.test(id))
    throw new AppError('BAD_REQUEST', { detail: 'Invalid cursor.' });
  return { time: parsed, id };
}

interface Standing {
  readonly owner: boolean;
  readonly permissions: number;
  readonly subscribed: boolean;
  /** Push notifications for new posts are on (subscribers only). */
  readonly notify: boolean;
}

/** Tells subscribers' devices about new posts (docs/notifications.md §1). */
export interface ChannelNotifier {
  channelPost(channelId: string): Promise<void>;
}

interface ChannelRow {
  id: string;
  owner_id: string;
  visibility: 'public' | 'private';
  comments_enabled: boolean;
  slow_mode_seconds: number;
}

export class ChannelsService {
  readonly #db: Kysely<Database>;
  readonly #valkey: Redis;
  readonly #prefix: string;
  readonly #directory: ChannelDirectory;
  readonly #previews: LinkPreviewer;
  readonly #audit: AuditLog;
  readonly #logger: Logger;
  #notifier: ChannelNotifier | null = null;

  constructor(options: {
    db: Kysely<Database>;
    valkey: Redis;
    keyPrefix: string;
    directory: ChannelDirectory;
    previews: LinkPreviewer;
    audit: AuditLog;
    logger: Logger;
  }) {
    this.#db = options.db;
    this.#valkey = options.valkey;
    this.#prefix = options.keyPrefix;
    this.#directory = options.directory;
    this.#previews = options.previews;
    this.#audit = options.audit;
    this.#logger = options.logger;
  }

  // ---- access ----------------------------------------------------------------------------------

  async #channel(executor: Executor, id: string, lock = false) {
    let query = executor
      .selectFrom('channels')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  async #standing(executor: Executor, channel: ChannelRow, userId: string): Promise<Standing> {
    const [admin, subscriber] = await Promise.all([
      executor
        .selectFrom('channel_admins')
        .select('permissions')
        .where('channel_id', '=', channel.id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      executor
        .selectFrom('channel_subscribers')
        .select(['user_id', 'notify'])
        .where('channel_id', '=', channel.id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    ]);
    const owner = channel.owner_id === userId;
    return {
      owner,
      permissions: owner ? ALL_CHANNEL_PERMISSIONS : (admin?.permissions ?? 0),
      subscribed: subscriber !== undefined,
      notify: subscriber?.notify ?? false,
    };
  }

  /** Who can see a channel: anyone (public), or subscribers and admins (private). Others: 404. */
  async #viewer(executor: Executor, channel: ChannelRow, userId: string): Promise<Standing> {
    const standing = await this.#standing(executor, channel, userId);
    if (channel.visibility === 'private' && !standing.subscribed && standing.permissions === 0)
      throw new AppError('NOT_FOUND');
    return standing;
  }

  async #require(
    executor: Executor,
    channel: ChannelRow,
    userId: string,
    permission: ChannelPermission,
  ): Promise<Standing> {
    const standing = await this.#viewer(executor, channel, userId);
    if ((standing.permissions & CHANNEL_PERMISSIONS[permission]) === 0)
      throw new AppError('FORBIDDEN', { detail: 'Your channel role does not allow this.' });
    return standing;
  }

  async #subscriberCounts(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.#db
      .selectFrom('channel_subscriber_counts')
      .select(['channel_id', (eb) => eb.fn.sum<string>('count').as('total')])
      .where('channel_id', 'in', [...ids])
      .groupBy('channel_id')
      .execute();
    return new Map(rows.map((row) => [row.channel_id, Number(row.total)]));
  }

  async #adjustSubscribers(
    trx: Transaction<Database>,
    channelId: string,
    delta: 1 | -1,
  ): Promise<void> {
    const shard = randomInt(SHARDS);
    await trx
      .insertInto('channel_subscriber_counts')
      .values({ channel_id: channelId, shard, count: delta })
      .onConflict((oc) =>
        oc.columns(['channel_id', 'shard']).doUpdateSet({
          count: sql`channel_subscriber_counts.count + ${delta}`,
        }),
      )
      .execute();
    const day = dayString(new Date());
    await trx
      .insertInto('channel_subscriber_daily')
      .values({
        channel_id: channelId,
        day,
        shard,
        joined: delta === 1 ? 1 : 0,
        left_count: delta === 1 ? 0 : 1,
      })
      .onConflict((oc) =>
        oc
          .columns(['channel_id', 'day', 'shard'])
          .doUpdateSet(
            delta === 1
              ? { joined: sql`channel_subscriber_daily.joined + 1` }
              : { left_count: sql`channel_subscriber_daily.left_count + 1` },
          ),
      )
      .execute();
  }

  async #auditEntry(
    executor: Transaction<Database>,
    actorId: string | null,
    action: string,
    channelId: string,
    details: Record<string, string | number | boolean | null> = {},
    requestId?: string,
  ): Promise<void> {
    await this.#audit.record(
      {
        actorKind: actorId === null ? 'system' : 'user',
        actorId,
        action,
        targetKind: 'channel',
        targetId: channelId,
        ...(requestId === undefined ? {} : { requestId }),
        details,
      },
      executor,
    );
  }

  // ---- channels --------------------------------------------------------------------------------

  async create(
    actor: string,
    input: z.infer<typeof createChannelSchema>,
    requestId?: string,
  ): Promise<string> {
    const id = newId();
    await this.#db.transaction().execute(async (trx) => {
      const owned = await trx
        .selectFrom('channels')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('owner_id', '=', actor)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(owned.count) >= MAX_OWNED)
        throw new AppError('CONFLICT', { detail: `You can own up to ${MAX_OWNED} channels.` });
      const taken = await trx
        .selectFrom('channels')
        .select('id')
        .where('handle', '=', input.handle)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (taken !== undefined) throw new AppError('CONFLICT', { detail: 'This handle is taken.' });
      await trx
        .insertInto('channels')
        .values({
          id,
          handle: input.handle,
          title: input.title,
          description: input.description,
          visibility: input.visibility,
          comments_enabled: input.commentsEnabled,
          slow_mode_seconds: input.slowModeSeconds,
          owner_id: actor,
          last_post_at: null,
        })
        .execute();
      await trx
        .insertInto('channel_subscribers')
        .values({ channel_id: id, user_id: actor })
        .execute();
      await this.#adjustSubscribers(trx, id, 1);
      await this.#auditEntry(
        trx,
        actor,
        'channels.created',
        id,
        { visibility: input.visibility },
        requestId,
      );
    });
    return id;
  }

  async get(viewer: string, id: string): Promise<z.infer<typeof channelSchema>> {
    const channel = await this.#channel(this.#db, id);
    const me = await this.#viewer(this.#db, channel, viewer);
    const counts = await this.#subscriberCounts([id]);
    let pendingTransfer: z.infer<typeof channelSchema>['pendingTransfer'] = null;
    if (me.owner) {
      const transfer = await this.#db
        .selectFrom('channel_ownership_transfers')
        .selectAll()
        .where('channel_id', '=', id)
        .executeTakeFirst();
      if (transfer !== undefined) {
        const names = await this.#directory.usernames([transfer.to_user_id]);
        pendingTransfer = {
          toUserId: transfer.to_user_id,
          toUsername: names.get(transfer.to_user_id) ?? 'deleted',
          effectiveAt: transfer.effective_at.toISOString(),
        };
      }
    }
    return {
      id,
      handle: channel.handle,
      title: channel.title,
      description: channel.description,
      visibility: channel.visibility,
      subscriberCount: counts.get(id) ?? 0,
      lastPostAt: channel.last_post_at?.toISOString() ?? null,
      commentsEnabled: channel.comments_enabled,
      slowModeSeconds: channel.slow_mode_seconds,
      createdAt: channel.created_at.toISOString(),
      me: {
        subscribed: me.subscribed,
        notifications: me.notify,
        owner: me.owner,
        permissions: me.permissions,
      },
      pendingTransfer,
    };
  }

  /** Resolves a handle to a channel id (404 when the caller may not see it). */
  async byHandle(viewer: string, handle: string): Promise<{ id: string }> {
    const row = await this.#db
      .selectFrom('channels')
      .select('id')
      .where('handle', '=', handle)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    await this.#viewer(this.#db, await this.#channel(this.#db, row.id), viewer);
    return row;
  }

  async #summaries(
    rows: readonly {
      id: string;
      handle: string;
      title: string;
      description: string;
      visibility: 'public' | 'private';
      last_post_at: Date | null;
    }[],
  ): Promise<z.infer<typeof channelListSchema>> {
    const counts = await this.#subscriberCounts(rows.map((row) => row.id));
    return {
      channels: rows.map((row) => ({
        id: row.id,
        handle: row.handle,
        title: row.title,
        description: row.description,
        visibility: row.visibility,
        subscriberCount: counts.get(row.id) ?? 0,
        lastPostAt: row.last_post_at?.toISOString() ?? null,
      })),
    };
  }

  /** Channels the user subscribes to or administers, most recently active first. */
  async mine(userId: string): Promise<z.infer<typeof channelListSchema>> {
    const rows = await this.#db
      .selectFrom('channels')
      .select(['id', 'handle', 'title', 'description', 'visibility', 'last_post_at'])
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('owner_id', '=', userId),
          eb.exists(
            eb
              .selectFrom('channel_subscribers')
              .select('user_id')
              .whereRef('channel_subscribers.channel_id', '=', 'channels.id')
              .where('channel_subscribers.user_id', '=', userId),
          ),
          eb.exists(
            eb
              .selectFrom('channel_admins')
              .select('user_id')
              .whereRef('channel_admins.channel_id', '=', 'channels.id')
              .where('channel_admins.user_id', '=', userId),
          ),
        ]),
      )
      .orderBy(sql`last_post_at DESC NULLS LAST`)
      .orderBy('title')
      .limit(500)
      .execute();
    return this.#summaries(rows);
  }

  /** Public channels whose handle or title matches, most subscribed first. */
  async discover(query: string): Promise<z.infer<typeof channelListSchema>> {
    const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.#db
      .selectFrom('channels')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('channel_subscriber_counts')
            .select(['channel_id', (e) => e.fn.sum<string>('count').as('total')])
            .groupBy('channel_id')
            .as('counts'),
        (join) => join.onRef('counts.channel_id', '=', 'channels.id'),
      )
      .select([
        'channels.id',
        'channels.handle',
        'channels.title',
        'channels.description',
        'channels.visibility',
        'channels.last_post_at',
      ])
      .where('channels.visibility', '=', 'public')
      .where('channels.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          sql<boolean>`channels.handle LIKE ${pattern} ESCAPE '\\'`,
          sql<boolean>`lower(channels.title) LIKE ${pattern} ESCAPE '\\'`,
        ]),
      )
      .orderBy(sql`coalesce(counts.total, 0)`, 'desc')
      .orderBy('channels.title')
      .limit(DIRECTORY_LIMIT)
      .execute();
    return this.#summaries(rows);
  }

  async update(
    actor: string,
    id: string,
    patch: z.infer<typeof updateChannelSchema>,
    requestId?: string,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id, true);
      await this.#require(trx, channel, actor, 'editChannelInfo');
      await trx
        .updateTable('channels')
        .set({
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
          ...(patch.commentsEnabled === undefined
            ? {}
            : { comments_enabled: patch.commentsEnabled }),
          ...(patch.slowModeSeconds === undefined
            ? {}
            : { slow_mode_seconds: patch.slowModeSeconds }),
        })
        .where('id', '=', id)
        .execute();
      await this.#auditEntry(
        trx,
        actor,
        'channels.updated',
        id,
        { fields: Object.keys(patch).sort().join(',') },
        requestId,
      );
    });
  }

  async delete(actor: string, id: string, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id, true);
      const me = await this.#viewer(trx, channel, actor);
      if (!me.owner)
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can delete the channel.' });
      await trx
        .updateTable('channels')
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .execute();
      await trx
        .updateTable('channel_links')
        .set({ revoked_at: new Date() })
        .where('channel_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute();
      await trx.deleteFrom('channel_ownership_transfers').where('channel_id', '=', id).execute();
      await this.#auditEntry(trx, actor, 'channels.deleted', id, {}, requestId);
    });
  }

  useNotifier(notifier: ChannelNotifier): void {
    this.#notifier = notifier;
  }

  /** Turns post notifications on or off for a subscriber. */
  async setNotifications(userId: string, id: string, enabled: boolean): Promise<void> {
    const channel = await this.#channel(this.#db, id);
    const me = await this.#viewer(this.#db, channel, userId);
    if (!me.subscribed)
      throw new AppError('CONFLICT', { detail: 'Subscribe to the channel first.' });
    await this.#db
      .updateTable('channel_subscribers')
      .set({ notify: enabled })
      .where('channel_id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Subscribers with post notifications on, in user id order (notification fan-out). */
  async notifiedSubscribers(id: string, after: string | null, limit: number): Promise<string[]> {
    let query = this.#db
      .selectFrom('channel_subscribers')
      .select('user_id')
      .where('channel_id', '=', id)
      .where('notify', '=', true)
      .orderBy('user_id')
      .limit(limit);
    if (after !== null) query = query.where('user_id', '>', after);
    return (await query.execute()).map((row) => row.user_id);
  }

  async isNotifiedSubscriber(id: string, userId: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom('channel_subscribers')
      .select('notify')
      .where('channel_id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.notify === true;
  }

  async #announcePosts(channelIds: readonly string[]): Promise<void> {
    for (const channelId of new Set(channelIds)) await this.#notifier?.channelPost(channelId);
  }

  async subscribe(userId: string, id: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id);
      if (channel.visibility !== 'public') {
        // Private channels are joined through an invite link; admins can always read them.
        await this.#viewer(trx, channel, userId);
      }
      await this.#addSubscriber(trx, id, userId);
    });
  }

  async #addSubscriber(trx: Transaction<Database>, id: string, userId: string): Promise<boolean> {
    const inserted = await trx
      .insertInto('channel_subscribers')
      .values({ channel_id: id, user_id: userId })
      .onConflict((oc) => oc.columns(['channel_id', 'user_id']).doNothing())
      .returning('user_id')
      .executeTakeFirst();
    if (inserted !== undefined) await this.#adjustSubscribers(trx, id, 1);
    return inserted !== undefined;
  }

  async unsubscribe(userId: string, id: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await this.#channel(trx, id);
      const removed = await trx
        .deleteFrom('channel_subscribers')
        .where('channel_id', '=', id)
        .where('user_id', '=', userId)
        .returning('user_id')
        .executeTakeFirst();
      if (removed !== undefined) await this.#adjustSubscribers(trx, id, -1);
    });
  }

  // ---- admins and ownership --------------------------------------------------------------------

  async admins(actor: string, id: string): Promise<z.infer<typeof channelAdminListSchema>> {
    const channel = await this.#channel(this.#db, id);
    const me = await this.#viewer(this.#db, channel, actor);
    if (me.permissions === 0) throw new AppError('FORBIDDEN');
    const rows = await this.#db
      .selectFrom('channel_admins')
      .select(['user_id', 'permissions'])
      .where('channel_id', '=', id)
      .orderBy('created_at')
      .execute();
    const names = await this.#directory.usernames([
      channel.owner_id,
      ...rows.map((r) => r.user_id),
    ]);
    return {
      admins: [
        {
          userId: channel.owner_id,
          username: names.get(channel.owner_id) ?? 'deleted',
          permissions: ALL_CHANNEL_PERMISSIONS,
        },
        ...rows.map((row) => ({
          userId: row.user_id,
          username: names.get(row.user_id) ?? 'deleted',
          permissions: row.permissions,
        })),
      ],
    };
  }

  /**
   * Adds or changes an admin. Admins never grant permissions they do not hold, and only the
   * owner changes an admin who can manage admins.
   */
  async setAdmin(
    actor: string,
    id: string,
    target: { userId?: string; username?: string },
    permissions: number,
    requestId?: string,
  ): Promise<void> {
    let userId = target.userId;
    if (userId === undefined) {
      const found = await this.#directory.discoverableByUsername(target.username ?? '');
      if (found === null) throw new AppError('NOT_FOUND', { detail: 'No such user.' });
      userId = found.id;
    }
    const subject = userId;
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id, true);
      const me = await this.#require(trx, channel, actor, 'manageAdmins');
      if (subject === channel.owner_id)
        throw new AppError('BAD_REQUEST', { detail: 'The owner already has every permission.' });
      if (!me.owner && (permissions & ~me.permissions) !== 0)
        throw new AppError('FORBIDDEN', {
          detail: 'You cannot grant permissions you do not have.',
        });
      const current = await trx
        .selectFrom('channel_admins')
        .select('permissions')
        .where('channel_id', '=', id)
        .where('user_id', '=', subject)
        .executeTakeFirst();
      if (
        !me.owner &&
        current !== undefined &&
        (current.permissions & CHANNEL_PERMISSIONS.manageAdmins) !== 0
      )
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can change this admin.' });
      await trx
        .insertInto('channel_admins')
        .values({ channel_id: id, user_id: subject, permissions, added_by: actor })
        .onConflict((oc) => oc.columns(['channel_id', 'user_id']).doUpdateSet({ permissions }))
        .execute();
      await this.#auditEntry(
        trx,
        actor,
        'channels.admins_changed',
        id,
        { target: subject, permissions },
        requestId,
      );
    });
  }

  async removeAdmin(actor: string, id: string, target: string, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id, true);
      const self = target === actor;
      const me = self
        ? await this.#viewer(trx, channel, actor)
        : await this.#require(trx, channel, actor, 'manageAdmins');
      const current = await trx
        .selectFrom('channel_admins')
        .select('permissions')
        .where('channel_id', '=', id)
        .where('user_id', '=', target)
        .executeTakeFirst();
      if (current === undefined) throw new AppError('NOT_FOUND');
      if (!self && !me.owner && (current.permissions & CHANNEL_PERMISSIONS.manageAdmins) !== 0)
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can remove this admin.' });
      await trx
        .deleteFrom('channel_admins')
        .where('channel_id', '=', id)
        .where('user_id', '=', target)
        .execute();
      await trx
        .deleteFrom('channel_ownership_transfers')
        .where('channel_id', '=', id)
        .where('to_user_id', '=', target)
        .execute();
      await this.#auditEntry(
        trx,
        actor,
        'channels.admins_changed',
        id,
        { target, permissions: 0 },
        requestId,
      );
    });
  }

  /**
   * Starts handing the channel to an admin. It takes effect after a cooling-off period
   * (OWNERSHIP_COOLDOWN_HOURS), so a stolen session cannot take a channel instantly.
   */
  async requestTransfer(
    actor: string,
    id: string,
    target: string,
    requestId?: string,
  ): Promise<string> {
    return this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id, true);
      const me = await this.#viewer(trx, channel, actor);
      if (!me.owner)
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can hand over the channel.' });
      const admin = await trx
        .selectFrom('channel_admins')
        .select('user_id')
        .where('channel_id', '=', id)
        .where('user_id', '=', target)
        .executeTakeFirst();
      if (admin === undefined)
        throw new AppError('BAD_REQUEST', { detail: 'Ownership can only go to an admin.' });
      const effectiveAt = new Date(Date.now() + OWNERSHIP_COOLDOWN_HOURS * 3_600_000);
      await trx
        .insertInto('channel_ownership_transfers')
        .values({
          channel_id: id,
          to_user_id: target,
          requested_by: actor,
          effective_at: effectiveAt,
        })
        .onConflict((oc) =>
          oc.column('channel_id').doUpdateSet({ to_user_id: target, effective_at: effectiveAt }),
        )
        .execute();
      await this.#auditEntry(
        trx,
        actor,
        'channels.ownership_requested',
        id,
        { to: target },
        requestId,
      );
      return effectiveAt.toISOString();
    });
  }

  async cancelTransfer(actor: string, id: string, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id, true);
      const me = await this.#viewer(trx, channel, actor);
      if (!me.owner) throw new AppError('FORBIDDEN');
      const deleted = await trx
        .deleteFrom('channel_ownership_transfers')
        .where('channel_id', '=', id)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      await this.#auditEntry(trx, actor, 'channels.ownership_cancelled', id, {}, requestId);
    });
  }

  // ---- invite links (private channels) ---------------------------------------------------------

  async createLink(
    actor: string,
    id: string,
    input: z.infer<typeof createChannelLinkSchema>,
  ): Promise<z.infer<typeof createdChannelLinkSchema>> {
    const channel = await this.#channel(this.#db, id);
    await this.#require(this.#db, channel, actor, 'editChannelInfo');
    const token = randomBytes(16).toString('base64url');
    const row = await this.#db
      .insertInto('channel_links')
      .values({
        id: newId(),
        channel_id: id,
        token_digest: digest(token),
        created_by: actor,
        expires_at: new Date(Date.now() + input.expiresInHours * 3_600_000),
        max_uses: input.maxUses,
      })
      .returning(['id', 'expires_at', 'max_uses', 'uses', 'created_at'])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      token,
      expiresAt: row.expires_at.toISOString(),
      maxUses: row.max_uses,
      uses: row.uses,
      createdAt: row.created_at.toISOString(),
    };
  }

  async links(actor: string, id: string): Promise<z.infer<typeof channelLinkListSchema>> {
    const channel = await this.#channel(this.#db, id);
    await this.#require(this.#db, channel, actor, 'editChannelInfo');
    const rows = await this.#db
      .selectFrom('channel_links')
      .select(['id', 'expires_at', 'max_uses', 'uses', 'created_at'])
      .where('channel_id', '=', id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where((eb) => eb.or([eb('max_uses', 'is', null), eb('uses', '<', eb.ref('max_uses'))]))
      .orderBy('created_at', 'desc')
      .execute();
    return {
      links: rows.map((row) => ({
        id: row.id,
        expiresAt: row.expires_at.toISOString(),
        maxUses: row.max_uses,
        uses: row.uses,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async revokeLink(actor: string, id: string, linkId: string): Promise<void> {
    const channel = await this.#channel(this.#db, id);
    await this.#require(this.#db, channel, actor, 'editChannelInfo');
    const result = await this.#db
      .updateTable('channel_links')
      .set({ revoked_at: new Date() })
      .where('id', '=', linkId)
      .where('channel_id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new AppError('NOT_FOUND');
  }

  async #liveLink(executor: Executor, token: string, lock = false) {
    let query = executor
      .selectFrom('channel_links')
      .selectAll()
      .where('token_digest', '=', digest(token))
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date());
    if (lock) query = query.forUpdate();
    const link = await query.executeTakeFirst();
    if (link === undefined || (link.max_uses !== null && link.uses >= link.max_uses))
      throw new AppError('NOT_FOUND', { detail: 'This invite link is invalid or has expired.' });
    return link;
  }

  async previewLink(
    userId: string,
    token: string,
  ): Promise<z.infer<typeof channelInvitePreviewSchema>> {
    const link = await this.#liveLink(this.#db, token);
    const channel = await this.#channel(this.#db, link.channel_id);
    const [summary] = (await this.#summaries([channel])).channels;
    const standing = await this.#standing(this.#db, channel, userId);
    if (summary === undefined) throw new AppError('NOT_FOUND');
    return { ...summary, subscribed: standing.subscribed };
  }

  async subscribeViaLink(userId: string, token: string): Promise<string> {
    return this.#db.transaction().execute(async (trx) => {
      const link = await this.#liveLink(trx, token, true);
      await this.#channel(trx, link.channel_id);
      if (await this.#addSubscriber(trx, link.channel_id, userId))
        await trx
          .updateTable('channel_links')
          .set({ uses: link.uses + 1 })
          .where('id', '=', link.id)
          .execute();
      return link.channel_id;
    });
  }

  // ---- posts -----------------------------------------------------------------------------------

  async createPost(
    actor: string,
    id: string,
    input: z.infer<typeof createPostSchema>,
  ): Promise<Post> {
    const channel = await this.#channel(this.#db, id);
    await this.#require(this.#db, channel, actor, 'post');
    const now = new Date();
    let status: ChannelPostStatus;
    let publishAt: Date | null = null;
    if (input.publish === 'now') status = 'published';
    else if (input.publish === 'draft') status = 'draft';
    else {
      publishAt = new Date(input.publish);
      if (publishAt.getTime() < now.getTime() + MIN_SCHEDULE_MS)
        throw new AppError('BAD_REQUEST', {
          detail: 'Schedule posts at least 15 seconds ahead, or publish now.',
        });
      if (publishAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * DAY_MS)
        throw new AppError('BAD_REQUEST', {
          detail: `Posts can be scheduled up to ${MAX_SCHEDULE_DAYS} days ahead.`,
        });
      status = 'scheduled';
    }
    // The preview is fetched by the server (never taken from the client), through the
    // SSRF-hardened fetcher; a page that cannot be previewed just has no card.
    const preview =
      input.previewUrl === null ? null : await this.#previews.preview(input.previewUrl);
    const postId = newId();
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('channel_posts')
        .values({
          id: postId,
          channel_id: id,
          author_id: actor,
          status,
          body: input.body,
          preview_url: input.previewUrl,
          preview: preview === null ? null : JSON.stringify(preview),
          publish_at: publishAt,
          published_at: status === 'published' ? now : null,
        })
        .execute();
      if (input.poll !== null)
        await trx
          .insertInto('channel_polls')
          .values({
            post_id: postId,
            question: input.poll.question,
            options: JSON.stringify(input.poll.options),
            multiple: input.poll.multiple,
            anonymous: input.poll.anonymous,
          })
          .execute();
      if (status === 'published')
        await trx.updateTable('channels').set({ last_post_at: now }).where('id', '=', id).execute();
    });
    if (status === 'published') await this.#announcePosts([id]);
    return this.#postById(actor, postId);
  }

  async #postRow(executor: Executor, id: string, postId: string) {
    const post = await executor
      .selectFrom('channel_posts')
      .selectAll()
      .where('id', '=', postId)
      .where('channel_id', '=', id)
      .executeTakeFirst();
    if (post === undefined) throw new AppError('NOT_FOUND');
    return post;
  }

  async #postById(viewer: string, postId: string): Promise<Post> {
    const row = await this.#db
      .selectFrom('channel_posts')
      .selectAll()
      .where('id', '=', postId)
      .executeTakeFirstOrThrow();
    const [post] = await this.#hydrate(viewer, [row]);
    if (post === undefined) throw new AppError('NOT_FOUND');
    return post;
  }

  /** Builds post views in a constant number of queries for a page of posts. */
  async #hydrate(
    viewer: string,
    rows: readonly {
      id: string;
      channel_id: string;
      author_id: string;
      status: ChannelPostStatus;
      body: string;
      preview: unknown;
      publish_at: Date | null;
      published_at: Date | null;
      edited_at: Date | null;
      created_at: Date;
    }[],
  ): Promise<Post[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [names, polls, tallies, myVotes, reactions, myReactions, comments] = await Promise.all([
      this.#directory.usernames([...new Set(rows.map((row) => row.author_id))]),
      this.#db.selectFrom('channel_polls').selectAll().where('post_id', 'in', ids).execute(),
      this.#db
        .selectFrom('channel_poll_votes')
        .select(['post_id', 'option', (eb) => eb.fn.countAll<string>().as('count')])
        .where('post_id', 'in', ids)
        .groupBy(['post_id', 'option'])
        .execute(),
      this.#db
        .selectFrom('channel_poll_votes')
        .select(['post_id', 'option'])
        .where('post_id', 'in', ids)
        .where('user_id', '=', viewer)
        .execute(),
      this.#db
        .selectFrom('channel_reaction_counts')
        .select(['post_id', 'emoji', 'count'])
        .where('post_id', 'in', ids)
        .where('count', '>', '0')
        .execute(),
      this.#db
        .selectFrom('channel_reactions')
        .select(['post_id', 'emoji'])
        .where('post_id', 'in', ids)
        .where('user_id', '=', viewer)
        .execute(),
      this.#db
        .selectFrom('channel_comments')
        .select(['post_id', (eb) => eb.fn.countAll<string>().as('count')])
        .where('post_id', 'in', ids)
        .where('removed_at', 'is', null)
        .groupBy('post_id')
        .execute(),
    ]);
    const voters = await this.#db
      .selectFrom('channel_poll_votes')
      .select(['post_id', (eb) => eb.fn.count<string>('user_id').distinct().as('count')])
      .where('post_id', 'in', ids)
      .groupBy('post_id')
      .execute();
    return rows.map((row) => {
      const poll = polls.find((p) => p.post_id === row.id);
      const options = poll === undefined ? [] : poll.options;
      return {
        id: row.id,
        channelId: row.channel_id,
        authorId: row.author_id,
        authorUsername: names.get(row.author_id) ?? 'deleted',
        status: row.status,
        body: row.status === 'removed' ? '' : row.body,
        preview:
          row.status === 'removed' || row.preview === null
            ? null
            : (row.preview as Post['preview']),
        poll:
          poll === undefined || row.status === 'removed'
            ? null
            : {
                question: poll.question,
                options,
                multiple: poll.multiple,
                anonymous: poll.anonymous,
                counts: options.map((_, index) =>
                  Number(
                    tallies.find((t) => t.post_id === row.id && t.option === index)?.count ?? 0,
                  ),
                ),
                voters: Number(voters.find((v) => v.post_id === row.id)?.count ?? 0),
                myChoices: myVotes.filter((v) => v.post_id === row.id).map((v) => v.option),
              },
        reactions: reactions
          .filter((r) => r.post_id === row.id)
          .map((r) => ({ emoji: r.emoji, count: Number(r.count) }))
          .sort((a, b) => b.count - a.count),
        myReaction: myReactions.find((r) => r.post_id === row.id)?.emoji ?? null,
        commentCount: Number(comments.find((c) => c.post_id === row.id)?.count ?? 0),
        publishAt: row.publish_at?.toISOString() ?? null,
        publishedAt: row.published_at?.toISOString() ?? null,
        editedAt: row.edited_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  /** Feed (published, newest first, keyset-paginated); admins who can post also list drafts. */
  async posts(
    viewer: string,
    id: string,
    query: {
      before?: string | undefined;
      status: 'published' | 'draft' | 'scheduled';
      limit: number;
    },
  ): Promise<z.infer<typeof postListSchema>> {
    const channel = await this.#channel(this.#db, id);
    if (query.status === 'published') await this.#viewer(this.#db, channel, viewer);
    else await this.#require(this.#db, channel, viewer, 'post');
    let q = this.#db
      .selectFrom('channel_posts')
      .selectAll()
      .where('channel_id', '=', id)
      .where('status', '=', query.status)
      .limit(query.limit + 1);
    if (query.status === 'published') {
      q = q.orderBy('published_at', 'desc').orderBy('id', 'desc');
      if (query.before !== undefined) {
        const cursor = decodeCursor(query.before);
        q = q.where((eb) =>
          eb.or([
            eb('published_at', '<', cursor.time),
            eb.and([eb('published_at', '=', cursor.time), eb('id', '<', cursor.id)]),
          ]),
        );
      }
    } else q = q.orderBy(query.status === 'scheduled' ? 'publish_at' : 'created_at', 'asc');
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      posts: await this.#hydrate(viewer, page),
      nextCursor:
        rows.length > query.limit && last?.published_at != null && query.status === 'published'
          ? encodeCursor(last.published_at, last.id)
          : null,
    };
  }

  async search(viewer: string, id: string, text: string): Promise<z.infer<typeof postListSchema>> {
    const channel = await this.#channel(this.#db, id);
    await this.#viewer(this.#db, channel, viewer);
    const rows = await this.#db
      .selectFrom('channel_posts')
      .selectAll()
      .where('channel_id', '=', id)
      .where('status', '=', 'published')
      .where(sql<boolean>`search @@ websearch_to_tsquery('simple', ${text})`)
      .orderBy('published_at', 'desc')
      .limit(20)
      .execute();
    return { posts: await this.#hydrate(viewer, rows), nextCursor: null };
  }

  async updatePost(actor: string, id: string, postId: string, body: string): Promise<Post> {
    const channel = await this.#channel(this.#db, id);
    const me = await this.#viewer(this.#db, channel, actor);
    const post = await this.#postRow(this.#db, id, postId);
    const mine = post.author_id === actor && (me.permissions & CHANNEL_PERMISSIONS.post) !== 0;
    if (!mine && (me.permissions & CHANNEL_PERMISSIONS.editAny) === 0)
      throw new AppError('FORBIDDEN', { detail: 'You cannot edit this post.' });
    if (post.status === 'removed') throw new AppError('NOT_FOUND');
    await this.#db
      .updateTable('channel_posts')
      .set({ body, ...(post.status === 'published' ? { edited_at: new Date() } : {}) })
      .where('id', '=', postId)
      .execute();
    return this.#postById(actor, postId);
  }

  /** Publishes a draft or scheduled post now (idempotent compare-and-set). */
  async publishNow(actor: string, id: string, postId: string): Promise<Post> {
    const channel = await this.#channel(this.#db, id);
    await this.#require(this.#db, channel, actor, 'post');
    await this.#postRow(this.#db, id, postId);
    await this.#publish([postId]);
    return this.#postById(actor, postId);
  }

  /** Moves posts from draft/scheduled to published exactly once, and bumps their channels. */
  async #publish(postIds: readonly string[]): Promise<string[]> {
    if (postIds.length === 0) return [];
    const rows = await this.#db.transaction().execute(async (trx) => {
      const now = new Date();
      const published = await trx
        .updateTable('channel_posts')
        .set({ status: 'published', published_at: now, publish_at: null })
        .where('id', 'in', [...postIds])
        .where('status', 'in', ['draft', 'scheduled'])
        .returning(['id', 'channel_id'])
        .execute();
      const channels = [...new Set(published.map((row) => row.channel_id))];
      if (channels.length > 0)
        await trx
          .updateTable('channels')
          .set({ last_post_at: now })
          .where('id', 'in', channels)
          .execute();
      return published;
    });
    await this.#announcePosts(rows.map((row) => row.channel_id));
    return rows.map((row) => row.id);
  }

  async deletePost(actor: string, id: string, postId: string, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id);
      const me = await this.#viewer(trx, channel, actor);
      const post = await this.#postRow(trx, id, postId);
      const mine = post.author_id === actor && (me.permissions & CHANNEL_PERMISSIONS.post) !== 0;
      if (!mine && (me.permissions & CHANNEL_PERMISSIONS.deleteAny) === 0)
        throw new AppError('FORBIDDEN', { detail: 'You cannot delete this post.' });
      if (post.status === 'removed') return;
      await trx
        .updateTable('channel_posts')
        .set({ status: 'removed', removed_at: new Date(), removed_by: actor, publish_at: null })
        .where('id', '=', postId)
        .execute();
      if (!mine)
        await this.#auditEntry(
          trx,
          actor,
          'channels.post_removed',
          id,
          { post: postId },
          requestId,
        );
    });
  }

  async #publishedPost(executor: Executor, id: string, postId: string) {
    const post = await this.#postRow(executor, id, postId);
    if (post.status !== 'published') throw new AppError('NOT_FOUND');
    return post;
  }

  // ---- reactions and polls ---------------------------------------------------------------------

  async react(userId: string, id: string, postId: string, emoji: string | null): Promise<Post> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id);
      await this.#viewer(trx, channel, userId);
      await this.#publishedPost(trx, id, postId);
      const previous = await trx
        .deleteFrom('channel_reactions')
        .where('post_id', '=', postId)
        .where('user_id', '=', userId)
        .returning('emoji')
        .executeTakeFirst();
      if (previous !== undefined)
        await trx
          .updateTable('channel_reaction_counts')
          .set({ count: sql`count - 1` })
          .where('post_id', '=', postId)
          .where('emoji', '=', previous.emoji)
          .execute();
      if (emoji !== null) {
        await trx
          .insertInto('channel_reactions')
          .values({ post_id: postId, user_id: userId, emoji })
          .execute();
        await trx
          .insertInto('channel_reaction_counts')
          .values({ post_id: postId, emoji, count: 1 })
          .onConflict((oc) =>
            oc
              .columns(['post_id', 'emoji'])
              .doUpdateSet({ count: sql`channel_reaction_counts.count + 1` }),
          )
          .execute();
      }
    });
    return this.#postById(userId, postId);
  }

  async vote(
    userId: string,
    id: string,
    postId: string,
    choices: readonly number[],
  ): Promise<Post> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id);
      await this.#viewer(trx, channel, userId);
      await this.#publishedPost(trx, id, postId);
      const poll = await trx
        .selectFrom('channel_polls')
        .selectAll()
        .where('post_id', '=', postId)
        .executeTakeFirst();
      if (poll === undefined) throw new AppError('NOT_FOUND');
      const options = poll.options;
      const unique = [...new Set(choices)];
      if (unique.some((choice) => choice >= options.length))
        throw new AppError('BAD_REQUEST', { detail: 'No such option.' });
      if (!poll.multiple && unique.length > 1)
        throw new AppError('BAD_REQUEST', { detail: 'Choose one option.' });
      await trx
        .deleteFrom('channel_poll_votes')
        .where('post_id', '=', postId)
        .where('user_id', '=', userId)
        .execute();
      if (unique.length > 0)
        await trx
          .insertInto('channel_poll_votes')
          .values(unique.map((option) => ({ post_id: postId, user_id: userId, option })))
          .execute();
    });
    return this.#postById(userId, postId);
  }

  /** Who voted for what — only for polls created as public. */
  async voters(
    viewer: string,
    id: string,
    postId: string,
  ): Promise<z.infer<typeof pollVotersSchema>> {
    const channel = await this.#channel(this.#db, id);
    await this.#viewer(this.#db, channel, viewer);
    await this.#publishedPost(this.#db, id, postId);
    const poll = await this.#db
      .selectFrom('channel_polls')
      .selectAll()
      .where('post_id', '=', postId)
      .executeTakeFirst();
    if (poll === undefined || poll.anonymous)
      throw new AppError('NOT_FOUND', { detail: 'This poll is anonymous.' });
    const votes = await this.#db
      .selectFrom('channel_poll_votes')
      .select(['user_id', 'option'])
      .where('post_id', '=', postId)
      .orderBy('created_at')
      .limit(5000)
      .execute();
    const names = await this.#directory.usernames([...new Set(votes.map((v) => v.user_id))]);
    const options = poll.options;
    return {
      options: options.map((_, option) => ({
        option,
        usernames: votes
          .filter((v) => v.option === option)
          .map((v) => names.get(v.user_id) ?? 'deleted'),
      })),
    };
  }

  // ---- comments --------------------------------------------------------------------------------

  async comments(
    viewer: string,
    id: string,
    postId: string,
    after: string | undefined,
  ): Promise<z.infer<typeof commentListSchema>> {
    const channel = await this.#channel(this.#db, id);
    await this.#viewer(this.#db, channel, viewer);
    await this.#publishedPost(this.#db, id, postId);
    let query = this.#db
      .selectFrom('channel_comments')
      .select(['id', 'author_id', 'body', 'created_at'])
      .where('post_id', '=', postId)
      .where('removed_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .limit(51);
    if (after !== undefined) {
      const cursor = decodeCursor(after);
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '>', cursor.time),
          eb.and([eb('created_at', '=', cursor.time), eb('id', '>', cursor.id)]),
        ]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, 50);
    const names = await this.#directory.usernames([...new Set(page.map((r) => r.author_id))]);
    const last = page.at(-1);
    return {
      comments: page.map((row) => ({
        id: row.id,
        authorId: row.author_id,
        authorUsername: names.get(row.author_id) ?? 'deleted',
        body: row.body,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor:
        rows.length > 50 && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async addComment(
    userId: string,
    id: string,
    postId: string,
    body: string,
  ): Promise<z.infer<typeof commentSchema>> {
    const channel = await this.#channel(this.#db, id);
    const me = await this.#viewer(this.#db, channel, userId);
    await this.#publishedPost(this.#db, id, postId);
    const moderator = (me.permissions & CHANNEL_PERMISSIONS.manageComments) !== 0;
    if (!channel.comments_enabled && !moderator)
      throw new AppError('FORBIDDEN', { detail: 'Comments are turned off in this channel.' });
    if (!me.subscribed && me.permissions === 0)
      throw new AppError('FORBIDDEN', { detail: 'Subscribe to comment.' });
    if (channel.slow_mode_seconds > 0 && !moderator) {
      const latest = await this.#db
        .selectFrom('channel_comments')
        .innerJoin('channel_posts', 'channel_posts.id', 'channel_comments.post_id')
        .select('channel_comments.created_at')
        .where('channel_posts.channel_id', '=', id)
        .where('channel_comments.author_id', '=', userId)
        .orderBy('channel_comments.created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const wait =
        latest === undefined
          ? 0
          : Math.ceil(
              (latest.created_at.getTime() + channel.slow_mode_seconds * 1000 - Date.now()) / 1000,
            );
      if (wait > 0)
        throw new AppError('RATE_LIMITED', {
          detail: `Slow mode is on: you can comment again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        });
    }
    const row = await this.#db
      .insertInto('channel_comments')
      .values({ id: newId(), post_id: postId, author_id: userId, body })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
    const names = await this.#directory.usernames([userId]);
    return {
      id: row.id,
      authorId: userId,
      authorUsername: names.get(userId) ?? 'deleted',
      body,
      createdAt: row.created_at.toISOString(),
    };
  }

  async deleteComment(
    actor: string,
    id: string,
    commentId: string,
    requestId?: string,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const channel = await this.#channel(trx, id);
      const me = await this.#viewer(trx, channel, actor);
      const comment = await trx
        .selectFrom('channel_comments')
        .innerJoin('channel_posts', 'channel_posts.id', 'channel_comments.post_id')
        .select([
          'channel_comments.id',
          'channel_comments.author_id',
          'channel_comments.removed_at',
        ])
        .where('channel_comments.id', '=', commentId)
        .where('channel_posts.channel_id', '=', id)
        .executeTakeFirst();
      if (comment?.removed_at !== null) throw new AppError('NOT_FOUND');
      const mine = comment.author_id === actor;
      if (!mine && (me.permissions & CHANNEL_PERMISSIONS.manageComments) === 0)
        throw new AppError('FORBIDDEN', { detail: 'You cannot delete this comment.' });
      await trx
        .updateTable('channel_comments')
        .set({ removed_at: new Date(), removed_by: actor })
        .where('id', '=', commentId)
        .execute();
      if (!mine)
        await this.#auditEntry(
          trx,
          actor,
          'channels.comment_removed',
          id,
          { comment: commentId },
          requestId,
        );
    });
  }

  // ---- views and analytics ---------------------------------------------------------------------

  #viewKey(postId: string, day: string): string {
    return `${this.#prefix}:cv:${postId}:${day}`;
  }

  /** Counts unique viewers per post per day (HyperLogLog; nothing per viewer is kept). */
  async recordViews(userId: string, id: string, postIds: readonly string[]): Promise<void> {
    const channel = await this.#channel(this.#db, id);
    await this.#viewer(this.#db, channel, userId);
    const posts = await this.#db
      .selectFrom('channel_posts')
      .select('id')
      .where('channel_id', '=', id)
      .where('status', '=', 'published')
      .where('id', 'in', [...new Set(postIds)])
      .execute();
    if (posts.length === 0) return;
    const day = dayString(new Date());
    const pipeline = this.#valkey.pipeline();
    for (const post of posts) {
      const key = this.#viewKey(post.id, day);
      pipeline.pfadd(key, userId);
      pipeline.expire(key, VIEW_KEY_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  async analytics(actor: string, id: string): Promise<z.infer<typeof channelAnalyticsSchema>> {
    const channel = await this.#channel(this.#db, id);
    await this.#require(this.#db, channel, actor, 'viewAnalytics');
    const since = dayString(new Date(Date.now() - (ANALYTICS_DAYS - 1) * DAY_MS));
    const today = dayString(new Date());
    const [counts, growth, posts] = await Promise.all([
      this.#subscriberCounts([id]),
      this.#db
        .selectFrom('channel_subscriber_daily')
        .select([
          sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'),
          (eb) => eb.fn.sum<string>('joined').as('joined'),
          (eb) => eb.fn.sum<string>('left_count').as('left'),
        ])
        .where('channel_id', '=', id)
        .where('day', '>=', since)
        .groupBy('day')
        .execute(),
      this.#db
        .selectFrom('channel_posts')
        .select(['id', 'body', 'published_at'])
        .where('channel_id', '=', id)
        .where('status', '=', 'published')
        .orderBy('published_at', 'desc')
        .limit(20)
        .execute(),
    ]);
    const postIds = posts.map((post) => post.id);
    const [rolled, reactions, comments, dailyViews] = await Promise.all([
      postIds.length === 0
        ? Promise.resolve([])
        : this.#db
            .selectFrom('channel_post_views')
            .select(['post_id', (eb) => eb.fn.sum<string>('views').as('views')])
            .where('post_id', 'in', postIds)
            .where('day', '<', today)
            .groupBy('post_id')
            .execute(),
      postIds.length === 0
        ? Promise.resolve([])
        : this.#db
            .selectFrom('channel_reaction_counts')
            .select(['post_id', (eb) => eb.fn.sum<string>('count').as('count')])
            .where('post_id', 'in', postIds)
            .groupBy('post_id')
            .execute(),
      postIds.length === 0
        ? Promise.resolve([])
        : this.#db
            .selectFrom('channel_comments')
            .select(['post_id', (eb) => eb.fn.countAll<string>().as('count')])
            .where('post_id', 'in', postIds)
            .where('removed_at', 'is', null)
            .groupBy('post_id')
            .execute(),
      this.#db
        .selectFrom('channel_post_views')
        .innerJoin('channel_posts', 'channel_posts.id', 'channel_post_views.post_id')
        .select([
          sql<string>`to_char(channel_post_views.day, 'YYYY-MM-DD')`.as('day'),
          (eb) => eb.fn.sum<string>('channel_post_views.views').as('views'),
        ])
        .where('channel_posts.channel_id', '=', id)
        .where('channel_post_views.day', '>=', since)
        .where('channel_post_views.day', '<', today)
        .groupBy('channel_post_views.day')
        .execute(),
    ]);
    // Today is read live from the HyperLogLogs of the recent posts.
    const live = await Promise.all(
      postIds.map((postId) => this.#valkey.pfcount(this.#viewKey(postId, today)).catch(() => 0)),
    );
    const todayViews = live.reduce((sum, value) => sum + value, 0);
    const days = Array.from({ length: ANALYTICS_DAYS }, (_, index) =>
      dayString(new Date(Date.now() - (ANALYTICS_DAYS - 1 - index) * DAY_MS)),
    );
    return {
      subscriberCount: counts.get(id) ?? 0,
      days: days.map((day) => {
        const g = growth.find((row) => row.day === day);
        return {
          day,
          joined: Number(g?.joined ?? 0),
          left: Number(g?.left ?? 0),
          views:
            day === today
              ? todayViews
              : Number(dailyViews.find((row) => row.day === day)?.views ?? 0),
        };
      }),
      posts: posts.map((post, index) => ({
        id: post.id,
        excerpt: post.body.slice(0, 80),
        publishedAt: (post.published_at ?? new Date()).toISOString(),
        views:
          Number(rolled.find((row) => row.post_id === post.id)?.views ?? 0) + (live[index] ?? 0),
        reactions: Number(reactions.find((row) => row.post_id === post.id)?.count ?? 0),
        comments: Number(comments.find((row) => row.post_id === post.id)?.count ?? 0),
      })),
    };
  }

  // ---- background work (scheduler) -------------------------------------------------------------

  /**
   * Publishes due scheduled posts and applies due ownership transfers. Safe to run on any number
   * of instances: publishing is a compare-and-set, so each post goes out exactly once.
   */
  async runDue(now = new Date()): Promise<{ published: number; transfers: number }> {
    const due = await this.#db
      .selectFrom('channel_posts')
      .select('id')
      .where('status', '=', 'scheduled')
      .where('publish_at', '<=', now)
      .orderBy('publish_at')
      .limit(500)
      .execute();
    const published = await this.#publish(due.map((row) => row.id));

    const transfers = await this.#db
      .selectFrom('channel_ownership_transfers')
      .selectAll()
      .where('effective_at', '<=', now)
      .limit(100)
      .execute();
    let applied = 0;
    for (const transfer of transfers) {
      await this.#db.transaction().execute(async (trx) => {
        const channel = await trx
          .selectFrom('channels')
          .select(['id', 'owner_id'])
          .where('id', '=', transfer.channel_id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        const still = await trx
          .deleteFrom('channel_ownership_transfers')
          .where('channel_id', '=', transfer.channel_id)
          .where('effective_at', '<=', now)
          .returning('to_user_id')
          .executeTakeFirst();
        if (channel === undefined || still === undefined) return;
        await trx
          .updateTable('channels')
          .set({ owner_id: still.to_user_id })
          .where('id', '=', channel.id)
          .execute();
        await trx
          .deleteFrom('channel_admins')
          .where('channel_id', '=', channel.id)
          .where('user_id', '=', still.to_user_id)
          .execute();
        // The previous owner stays on as a full admin.
        await trx
          .insertInto('channel_admins')
          .values({
            channel_id: channel.id,
            user_id: channel.owner_id,
            permissions: ALL_CHANNEL_PERMISSIONS,
            added_by: still.to_user_id,
          })
          .onConflict((oc) =>
            oc
              .columns(['channel_id', 'user_id'])
              .doUpdateSet({ permissions: ALL_CHANNEL_PERMISSIONS }),
          )
          .execute();
        await this.#auditEntry(trx, null, 'channels.ownership_transferred', channel.id, {
          from: channel.owner_id,
          to: still.to_user_id,
        });
        applied += 1;
      });
    }
    if (published.length > 0 || applied > 0)
      this.#logger.info('channels.scheduler', { count: published.length + applied });
    return { published: published.length, transfers: applied };
  }

  /** Persists daily unique-viewer counts for recent posts (today and yesterday). */
  async rollUpViews(now = new Date()): Promise<void> {
    const posts = await this.#db
      .selectFrom('channel_posts')
      .select('id')
      .where('status', '=', 'published')
      .where('published_at', '>=', new Date(now.getTime() - 35 * DAY_MS))
      .limit(10_000)
      .execute();
    for (const day of [dayString(new Date(now.getTime() - DAY_MS)), dayString(now)]) {
      for (let i = 0; i < posts.length; i += 200) {
        const batch = posts.slice(i, i + 200);
        const counts = await Promise.all(
          batch.map((post) => this.#valkey.pfcount(this.#viewKey(post.id, day))),
        );
        const rows = batch
          .map((post, index) => ({ post_id: post.id, day, views: counts[index] ?? 0 }))
          .filter((row) => row.views > 0);
        if (rows.length > 0)
          await this.#db
            .insertInto('channel_post_views')
            .values(rows)
            .onConflict((oc) =>
              oc.columns(['post_id', 'day']).doUpdateSet({ views: sql`excluded.views` }),
            )
            .execute();
      }
    }
  }
}
