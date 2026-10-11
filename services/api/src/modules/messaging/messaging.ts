import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  SUPPORTED_CIPHERSUITES,
  type Conversation,
  type MailboxMessage,
  type WelcomeMessage,
} from '@tessera/validation';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import type { FrankingTagger } from '../../platform/franking.js';
import type { RealtimePublisher } from '../../platform/realtime-publisher.js';

/**
 * Conversations and the ciphertext mailbox (docs/messaging.md, ADR-009/010).
 *
 * Guarantees:
 * - total order per conversation: `seq` is assigned under a row lock on the conversation, so
 *   concurrent senders serialise per conversation only (never globally);
 * - idempotency: (conversation, sender, clientMessageId) is unique — retries return the original seq;
 * - authorization: every read and write checks current membership;
 * - retention: ciphertext is deleted when every member acknowledged it or after the retention
 *   window (or the disappearing timer, if shorter).
 * - MLS delivery service (ADR-009, crypto-design §5): commits are accepted only for the
 *   conversation's current epoch (compare-and-set) and advance it; Welcomes are held per target
 *   device until acknowledged.
 * The server never interprets `ciphertext`, commits or Welcomes; it cannot decrypt them.
 */

export interface MessagingConfig {
  readonly retentionDays: number;
}

/** Device checks, provided by the keys module. */
export interface MessagingDevices {
  isActiveDevice(userId: string, deviceId: string): Promise<boolean>;
}

/** Links attachments to the conversation inside the send transaction (media module). */
export interface MessagingAttachments {
  attach(
    trx: Transaction<Database>,
    input: { userId: string; conversationId: string; blobIds: readonly string[]; expiresAt: Date },
  ): Promise<void>;
}

/** Blocks between two people (moderation; docs/moderation.md §2). */
export interface MessagingBlocks {
  blockedEitherWay(a: string, b: string): Promise<boolean>;
}

/** New-account limits and moderation restrictions on starting conversations. */
export interface MessagingCreationGuard {
  assertMay(userId: string, kind: 'chat' | 'group' | 'channel' | 'invite'): Promise<void>;
}

/** Wakes recipients' devices that are not connected (docs/notifications.md §2). */
export interface MessagingNotifier {
  messageStored(conversationId: string, senderUserId: string, memberIds: string[]): Promise<void>;
}

export interface MessagingDirectory {
  discoverableByUsername(username: string): Promise<{ id: string; username: string } | null>;
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
}

type Executor = Kysely<Database> | Transaction<Database>;

interface CursorPosition {
  readonly t: string;
  readonly id: string;
}

const DAY_MS = 24 * 60 * 60_000;
const SWEEP_BATCH = 1000;

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

function decodeCursor(cursor: string): CursorPosition {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<CursorPosition>;
    if (
      typeof value.t === 'string' &&
      typeof value.id === 'string' &&
      !Number.isNaN(Date.parse(value.t))
    ) {
      return { t: value.t, id: value.id };
    }
  } catch {
    // fall through
  }
  throw new AppError('BAD_REQUEST', { detail: 'Invalid cursor.' });
}

export class MessagingService {
  readonly #db: Kysely<Database>;
  readonly #directory: MessagingDirectory;
  readonly #publisher: RealtimePublisher;
  readonly #config: MessagingConfig;
  readonly #logger: Logger;
  #devices: MessagingDevices | null = null;
  #attachments: MessagingAttachments | null = null;
  #notifier: MessagingNotifier | null = null;
  #franking: FrankingTagger | null = null;
  #blocks: MessagingBlocks | null = null;
  #guard: MessagingCreationGuard | null = null;

  constructor(
    db: Kysely<Database>,
    directory: MessagingDirectory,
    publisher: RealtimePublisher,
    config: MessagingConfig,
    logger: Logger,
  ) {
    this.#db = db;
    this.#directory = directory;
    this.#publisher = publisher;
    this.#config = config;
    this.#logger = logger;
  }

  /** Wired by the composition root (keys and messaging depend on each other's interfaces). */
  useNotifier(notifier: MessagingNotifier): void {
    this.#notifier = notifier;
  }

  useFranking(franking: FrankingTagger): void {
    this.#franking = franking;
  }

  useSafety(blocks: MessagingBlocks, guard: MessagingCreationGuard): void {
    this.#blocks = blocks;
    this.#guard = guard;
  }

  /** The other member of a direct conversation (null for groups or unknown conversations). */
  async directPeer(userId: string, conversationId: string): Promise<string | null> {
    const context = await this.callContext(conversationId);
    if (context?.kind !== 'direct') return null;
    return context.memberIds.find((id) => id !== userId) ?? null;
  }

  useAttachments(attachments: MessagingAttachments): void {
    this.#attachments = attachments;
  }

  useDevices(devices: MessagingDevices): void {
    this.#devices = devices;
  }

  async #requireActiveDevice(userId: string, deviceId: string): Promise<void> {
    if (this.#devices === null || !(await this.#devices.isActiveDevice(userId, deviceId)))
      throw new AppError('FORBIDDEN', { detail: 'This device is not registered for encryption.' });
  }

  #assertCiphersuite(ciphersuite: number): void {
    if (SUPPORTED_CIPHERSUITES.includes(ciphersuite)) return;
    throw new AppError('BAD_REQUEST', { detail: 'Unsupported ciphersuite.' });
  }

  /** Finds or creates the single direct conversation between the caller and `username`. */
  async openDirect(userId: string, username: string, ciphersuite: number): Promise<Conversation> {
    this.#assertCiphersuite(ciphersuite);
    const peer = await this.#directory.discoverableByUsername(username);
    if (peer === null || peer.id === userId)
      throw new AppError('NOT_FOUND', { detail: 'No one with that username.' });
    const [low, high] = userId < peer.id ? [userId, peer.id] : [peer.id, userId];

    const existing = await this.#db
      .selectFrom('direct_pairs')
      .select('conversation_id')
      .where('user_low', '=', low)
      .where('user_high', '=', high)
      .executeTakeFirst();
    if (existing !== undefined) return this.get(userId, existing.conversation_id);
    if ((await this.#blocks?.blockedEitherWay(userId, peer.id)) === true)
      throw new AppError('FORBIDDEN', { detail: 'You can’t message this person.' });
    await this.#guard?.assertMay(userId, 'chat');

    const conversationId = newId();
    const created = await this.#db
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('conversations')
          .values({ id: conversationId, kind: 'direct', ciphersuite, created_by: userId })
          .execute();
        await trx
          .insertInto('conversation_members')
          .values([
            { conversation_id: conversationId, user_id: userId, role: 'owner' },
            { conversation_id: conversationId, user_id: peer.id, role: 'member' },
          ])
          .execute();
        await trx
          .insertInto('direct_pairs')
          .values({ user_low: low, user_high: high, conversation_id: conversationId })
          .execute();
        return true;
      })
      .catch((error: unknown) => {
        // Both users opened the chat at the same moment: the pair's primary key decides.
        if ((error as { code?: string }).code === '23505') return false;
        throw error;
      });

    if (!created) {
      const winner = await this.#db
        .selectFrom('direct_pairs')
        .select('conversation_id')
        .where('user_low', '=', low)
        .where('user_high', '=', high)
        .executeTakeFirstOrThrow();
      return this.get(userId, winner.conversation_id);
    }
    this.#publisher.publish([peer.id], { type: 'conversation', conversationId });
    return this.get(userId, conversationId);
  }

  async list(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ conversations: Conversation[]; nextCursor: string | null }> {
    let query = this.#db
      .selectFrom('conversations')
      .innerJoin('conversation_members as me', (join) =>
        join
          .onRef('me.conversation_id', '=', 'conversations.id')
          .on('me.user_id', '=', userId)
          .on('me.left_at', 'is', null),
      )
      .select(['conversations.id', 'conversations.last_activity_at'])
      .orderBy('conversations.last_activity_at', 'desc')
      .orderBy('conversations.id', 'desc')
      .limit(limit + 1);
    if (cursor !== undefined) {
      const position = decodeCursor(cursor);
      query = query.where((eb) =>
        eb.or([
          eb('conversations.last_activity_at', '<', new Date(position.t)),
          eb.and([
            eb('conversations.last_activity_at', '=', new Date(position.t)),
            eb('conversations.id', '<', position.id),
          ]),
        ]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const conversations = await this.#hydrate(
      userId,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    return {
      conversations,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ t: last.last_activity_at.toISOString(), id: last.id })
          : null,
    };
  }

  async get(userId: string, conversationId: string): Promise<Conversation> {
    const [conversation] = await this.#hydrate(userId, [conversationId]);
    if (conversation === undefined) throw new AppError('NOT_FOUND');
    return conversation;
  }

  async send(
    userId: string,
    conversationId: string,
    input: {
      clientMessageId: string;
      senderDeviceId: string;
      epoch: number;
      ciphertext: Buffer;
      attachments?: readonly string[] | undefined;
      /** Franking commitment (32 bytes), see platform/franking.ts. */
      commitment?: Buffer | undefined;
    },
  ): Promise<{ message: MailboxMessage; duplicate: boolean }> {
    await this.#requireActiveDevice(userId, input.senderDeviceId);
    // Blocks (docs/moderation.md §2), checked before the transaction: the moderation module uses
    // its own connection, which must not be awaited while this one holds the conversation lock.
    if (this.#blocks !== null) {
      const peer = await this.#db
        .selectFrom('conversation_members as m')
        .innerJoin('conversations as c', 'c.id', 'm.conversation_id')
        .select('m.user_id')
        .where('c.id', '=', conversationId)
        .where('c.kind', '=', 'direct')
        .where('m.user_id', '!=', userId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('conversation_members as me')
              .select('me.user_id')
              .whereRef('me.conversation_id', '=', 'c.id')
              .where('me.user_id', '=', userId)
              .where('me.left_at', 'is', null),
          ),
        )
        .executeTakeFirst();
      if (peer !== undefined && (await this.#blocks.blockedEitherWay(userId, peer.user_id)))
        throw new AppError('FORBIDDEN', { detail: 'You can’t message this person.' });
    }
    const result = await this.#db.transaction().execute(async (trx) => {
      const conversation = await this.#lockMembership(trx, userId, conversationId);
      // Announcements-only groups: only admins post (server mirror of the E2EE setting).
      if (conversation.announcements_only && conversation.role === 'member')
        throw new AppError('FORBIDDEN', { detail: 'Only admins can send messages in this group.' });
      const existing = await trx
        .selectFrom('mailbox_messages')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .where('sender_user_id', '=', userId)
        .where('client_message_id', '=', input.clientMessageId)
        .executeTakeFirst();
      if (existing !== undefined) return { row: existing, duplicate: true };

      if (input.epoch !== Number(conversation.epoch)) {
        throw new AppError('CONFLICT', {
          detail: 'Conversation epoch changed; re-encrypt and retry.',
        });
      }
      const seq = Number(conversation.last_seq) + 1;
      const now = new Date();
      const retentionMs = this.#config.retentionDays * DAY_MS;
      const ttlMs =
        conversation.disappearing_seconds > 0
          ? Math.min(retentionMs, conversation.disappearing_seconds * 1000)
          : retentionMs;
      const row = await trx
        .insertInto('mailbox_messages')
        .values({
          conversation_id: conversationId,
          seq,
          kind: 1,
          client_message_id: input.clientMessageId,
          sender_user_id: userId,
          sender_device_id: input.senderDeviceId,
          epoch: input.epoch,
          ciphertext: input.ciphertext,
          created_at: now,
          expires_at: new Date(now.getTime() + ttlMs),
          commitment: input.commitment ?? null,
          franking_tag:
            input.commitment === undefined || this.#franking === null
              ? null
              : this.#franking.tag(input.commitment, {
                  conversationId,
                  seq,
                  senderUserId: userId,
                  senderDeviceId: input.senderDeviceId,
                  clientMessageId: input.clientMessageId,
                  serverTime: now.toISOString(),
                }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.attachments !== undefined && input.attachments.length > 0) {
        if (this.#attachments === null) throw new Error('messaging: attachments not configured');
        await this.#attachments.attach(trx, {
          userId,
          conversationId,
          blobIds: input.attachments,
          expiresAt: row.expires_at,
        });
      }
      await trx
        .updateTable('conversations')
        .set({ last_seq: seq, last_activity_at: now })
        .where('id', '=', conversationId)
        .execute();
      // The sender already has its own message.
      await trx
        .updateTable('conversation_members')
        .set({ acked_seq: seq })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .execute();
      return { row, duplicate: false };
    });

    const message = toMessage(result.row);
    if (!result.duplicate) {
      const members = await this.#memberIds(this.#db, conversationId);
      this.#publisher.publish(members, { type: 'message', conversationId, message });
      await this.#notifier?.messageStored(conversationId, userId, members);
    }
    return { message, duplicate: result.duplicate };
  }

  /**
   * Appends an MLS commit if `epoch` is the conversation's current epoch, advancing it
   * (compare-and-set, ADR-009); otherwise 409 and the client processes the winning commit and
   * re-bases. Welcomes for added devices are stored per target device.
   */
  async commit(
    userId: string,
    conversationId: string,
    input: {
      clientMessageId: string;
      senderDeviceId: string;
      epoch: number;
      commit: Buffer;
      welcome: Buffer | null;
      welcomeTargets: readonly { userId: string; deviceId: string }[];
    },
  ): Promise<{ message: MailboxMessage; epoch: number; duplicate: boolean }> {
    await this.#requireActiveDevice(userId, input.senderDeviceId);
    if ((input.welcome === null) !== (input.welcomeTargets.length === 0))
      throw new AppError('BAD_REQUEST', {
        detail: 'A welcome needs targets, and targets a welcome.',
      });
    const members = await this.#memberIds(this.#db, conversationId);
    for (const target of input.welcomeTargets) {
      if (
        !members.includes(target.userId) ||
        this.#devices === null ||
        !(await this.#devices.isActiveDevice(target.userId, target.deviceId))
      )
        throw new AppError('BAD_REQUEST', { detail: 'Welcome target is not a member device.' });
    }

    const result = await this.#db.transaction().execute(async (trx) => {
      const conversation = await this.#lockMembership(trx, userId, conversationId);
      const existing = await trx
        .selectFrom('mailbox_messages')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .where('sender_user_id', '=', userId)
        .where('client_message_id', '=', input.clientMessageId)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.kind !== 2) throw new AppError('CONFLICT', { detail: 'Id already used.' });
        return { row: existing, epoch: Number(existing.epoch) + 1, duplicate: true };
      }
      if (input.epoch !== Number(conversation.epoch)) {
        throw new AppError('CONFLICT', {
          detail: 'Another change to this conversation was accepted first.',
        });
      }
      const seq = Number(conversation.last_seq) + 1;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.#config.retentionDays * DAY_MS);
      const row = await trx
        .insertInto('mailbox_messages')
        .values({
          conversation_id: conversationId,
          seq,
          kind: 2,
          client_message_id: input.clientMessageId,
          sender_user_id: userId,
          sender_device_id: input.senderDeviceId,
          epoch: input.epoch,
          ciphertext: input.commit,
          created_at: now,
          expires_at: expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('conversations')
        .set({ last_seq: seq, epoch: input.epoch + 1 })
        .where('id', '=', conversationId)
        .execute();
      await trx
        .updateTable('conversation_members')
        .set({ acked_seq: seq })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .execute();
      if (input.welcome !== null && input.welcomeTargets.length > 0) {
        // One stored copy, referenced by every target device.
        const payloadId = newId();
        await trx
          .insertInto('mls_welcome_payloads')
          .values({
            id: payloadId,
            conversation_id: conversationId,
            welcome: input.welcome,
            expires_at: expiresAt,
          })
          .execute();
        await trx
          .insertInto('mls_welcomes')
          .values(
            input.welcomeTargets.map((target) => ({
              id: newId(),
              conversation_id: conversationId,
              target_user_id: target.userId,
              target_device_id: target.deviceId,
              commit_seq: seq,
              welcome: null,
              payload_id: payloadId,
              created_at: now,
              expires_at: expiresAt,
            })),
          )
          .execute();
      }
      return { row, epoch: input.epoch + 1, duplicate: false };
    });

    const message = toMessage(result.row);
    if (!result.duplicate) {
      this.#publisher.publish(members, { type: 'message', conversationId, message });
      const targets = [...new Set(input.welcomeTargets.map((target) => target.userId))];
      if (targets.length > 0) this.#publisher.publish(targets, { type: 'welcome', conversationId });
    }
    return { message, epoch: result.epoch, duplicate: result.duplicate };
  }

  /** Welcomes waiting for one of the caller's devices. */
  async welcomes(userId: string, deviceId: string): Promise<WelcomeMessage[]> {
    await this.#requireActiveDevice(userId, deviceId);
    const rows = await this.#db
      .selectFrom('mls_welcomes')
      .leftJoin('mls_welcome_payloads', 'mls_welcome_payloads.id', 'mls_welcomes.payload_id')
      .select([
        'mls_welcomes.id',
        'mls_welcomes.conversation_id',
        'mls_welcomes.commit_seq',
        'mls_welcomes.welcome',
        'mls_welcome_payloads.welcome as payload',
      ])
      .where('mls_welcomes.target_user_id', '=', userId)
      .where('mls_welcomes.target_device_id', '=', deviceId)
      .where('mls_welcomes.expires_at', '>', new Date())
      .orderBy('mls_welcomes.created_at', 'asc')
      // Welcomes of large groups are big: a page at a time.
      .limit(20)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      commitSeq: Number(row.commit_seq),
      welcome: (row.welcome ?? row.payload ?? Buffer.alloc(0)).toString('base64'),
    }));
  }

  /** The device processed (or permanently rejected) a Welcome: delete it. */
  async acknowledgeWelcome(userId: string, welcomeId: string): Promise<void> {
    const deleted = await this.#db
      .deleteFrom('mls_welcomes')
      .where('id', '=', welcomeId)
      .where('target_user_id', '=', userId)
      .executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
  }

  async messages(
    userId: string,
    conversationId: string,
    query: { after?: number | undefined; before?: number | undefined; limit: number },
  ): Promise<{ messages: MailboxMessage[]; earliestAvailableSeq: number; hasMore: boolean }> {
    await this.#requireMember(this.#db, userId, conversationId);
    let select = this.#db
      .selectFrom('mailbox_messages')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('expires_at', '>', new Date())
      .limit(query.limit + 1);
    if (query.before !== undefined) {
      select = select.where('seq', '<', String(query.before)).orderBy('seq', 'desc');
    } else {
      select = select.where('seq', '>', String(query.after ?? 0)).orderBy('seq', 'asc');
    }
    const rows = await select.execute();
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (query.before !== undefined) page.reverse();
    const earliest = await this.#db
      .selectFrom('mailbox_messages')
      .select((eb) => eb.fn.min<string>('seq').as('seq'))
      .where('conversation_id', '=', conversationId)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    return {
      messages: page.map(toMessage),
      earliestAvailableSeq: Number(earliest?.seq ?? 0),
      hasMore,
    };
  }

  /** Records that the caller's client has stored messages up to `seq` (delivery acknowledgement). */
  async acknowledge(userId: string, conversationId: string, seq: number): Promise<void> {
    // The common case in one statement (acks are most of the write traffic, docs/capacity.md §3):
    // a member moves its delivery position forward to a message that exists. The members to
    // notify, and the group's lowest position before and after, come back with it.
    const advanced = await sql<{
      kind: string;
      members: string[];
      before_min: string;
      after_min: string;
    }>`
      WITH moved AS (
        UPDATE conversation_members AS m SET acked_seq = ${seq}
        FROM conversations AS c
        WHERE m.conversation_id = ${conversationId} AND m.user_id = ${userId}
          AND m.left_at IS NULL AND m.acked_seq < ${seq}
          AND c.id = m.conversation_id AND c.last_seq >= ${seq}
        RETURNING m.conversation_id, c.kind
      )
      SELECT moved.kind, array_agg(o.user_id) AS members,
             min(o.acked_seq) AS before_min,
             min(CASE WHEN o.user_id = ${userId} THEN ${seq} ELSE o.acked_seq END) AS after_min
        FROM conversation_members AS o JOIN moved ON moved.conversation_id = o.conversation_id
       WHERE o.left_at IS NULL
       GROUP BY moved.kind`.execute(this.#db);
    const row = advanced.rows[0];
    if (row !== undefined) {
      if (row.kind === 'direct') {
        this.#publisher.publish(row.members, { type: 'receipt', conversationId, userId, seq });
      } else if (Number(row.after_min) > Number(row.before_min)) {
        // Groups: one receipt per message, when the last member has it ("delivered to
        // everyone"), instead of one per member — that was members² frames per message.
        this.#publisher.publish(row.members, {
          type: 'receipt',
          conversationId,
          userId,
          seq: Number(row.after_min),
        });
      }
      return;
    }
    // Nothing moved: not a member (404), an unknown message (400), or an ack at or behind the
    // current position (nothing to do).
    const conversation = await this.#requireMember(this.#db, userId, conversationId);
    if (seq > Number(conversation.last_seq))
      throw new AppError('BAD_REQUEST', { detail: 'Unknown sequence number.' });
  }

  /** Conversations with their last sequence number and the caller's acknowledged position. */
  async sync(userId: string): Promise<{ id: string; ackedSeq: number; lastSeq: number }[]> {
    const rows = await this.#db
      .selectFrom('conversation_members')
      .innerJoin('conversations', 'conversations.id', 'conversation_members.conversation_id')
      .select(['conversations.id', 'conversations.last_seq', 'conversation_members.acked_seq'])
      .where('conversation_members.user_id', '=', userId)
      .where('conversation_members.left_at', 'is', null)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      ackedSeq: Number(row.acked_seq),
      lastSeq: Number(row.last_seq),
    }));
  }

  async setDisappearing(
    userId: string,
    conversationId: string,
    seconds: number,
  ): Promise<Conversation> {
    await this.#requireMember(this.#db, userId, conversationId);
    await this.#db
      .updateTable('conversations')
      .set({ disappearing_seconds: seconds })
      .where('id', '=', conversationId)
      .execute();
    const members = await this.#memberIds(this.#db, conversationId);
    this.#publisher.publish(members, { type: 'conversation', conversationId });
    return this.get(userId, conversationId);
  }

  /** Users who share an active conversation with `userId`. */
  async contactsOf(userId: string): Promise<string[]> {
    const rows = await this.#db
      .selectFrom('conversation_members as mine')
      .innerJoin('conversation_members as other', 'other.conversation_id', 'mine.conversation_id')
      .select('other.user_id')
      .distinct()
      .where('mine.user_id', '=', userId)
      .where('mine.left_at', 'is', null)
      .where('other.left_at', 'is', null)
      .where('other.user_id', '!=', userId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  /**
   * True if the two users are both active members of some conversation, 1:1 or group (who may
   * read each other's public keys and claim KeyPackages: everyone in a group must be able to
   * verify everyone else's device certificates).
   */
  async sharesConversation(userA: string, userB: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom('conversation_members as a')
      .innerJoin('conversation_members as b', 'b.conversation_id', 'a.conversation_id')
      .innerJoin('conversations as c', 'c.id', 'a.conversation_id')
      .select('a.conversation_id')
      .where('a.user_id', '=', userA)
      .where('b.user_id', '=', userB)
      .where('a.left_at', 'is', null)
      .where('b.left_at', 'is', null)
      .where('c.deleted_at', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** True if the two users have a 1:1 conversation ("contacts" for privacy purposes). */
  async areContacts(userA: string, userB: string): Promise<boolean> {
    const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
    const row = await this.#db
      .selectFrom('direct_pairs')
      .select('conversation_id')
      .where('user_low', '=', low)
      .where('user_high', '=', high)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The subset of `conversationIds` the user currently belongs to. */
  async memberOf(userId: string, conversationIds: readonly string[]): Promise<string[]> {
    if (conversationIds.length === 0) return [];
    const rows = await this.#db
      .selectFrom('conversation_members')
      .select('conversation_id')
      .where('user_id', '=', userId)
      .where('left_at', 'is', null)
      .where('conversation_id', 'in', conversationIds)
      .execute();
    return rows.map((row) => row.conversation_id);
  }

  /** Kind and current members of a live conversation (calls module), or null if there is none. */
  async callContext(
    conversationId: string,
  ): Promise<{ kind: 'direct' | 'group'; memberIds: string[] } | null> {
    const conversation = await this.#db
      .selectFrom('conversations')
      .select('kind')
      .where('id', '=', conversationId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (conversation === undefined) return null;
    return { kind: conversation.kind, memberIds: await this.#memberIds(this.#db, conversationId) };
  }

  async isMember(userId: string, conversationId: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom('conversation_members')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .where('left_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Deletes expired ciphertext and ciphertext every member has acknowledged, in small batches to
   * avoid long locks. Returns the number of rows deleted.
   */
  /** Messages accepted since `since` (admin dashboard aggregate; no content exists here). */
  async countSince(since: Date): Promise<number> {
    const row = await this.#db
      .selectFrom('mailbox_messages')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('created_at', '>', since)
      .where('kind', '=', 1)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async sweep(): Promise<number> {
    let total = 0;
    for (;;) {
      const expired = await sql<{ n: string }>`
        WITH doomed AS (
          SELECT conversation_id, seq FROM mailbox_messages WHERE expires_at <= now() LIMIT ${SWEEP_BATCH}
        )
        DELETE FROM mailbox_messages m USING doomed d
        WHERE m.conversation_id = d.conversation_id AND m.seq = d.seq`.execute(this.#db);
      const n = Number(expired.numAffectedRows ?? 0);
      total += n;
      if (n < SWEEP_BATCH) break;
    }
    for (;;) {
      const delivered = await sql`
        WITH floor AS (
          SELECT conversation_id, min(acked_seq) AS acked
          FROM conversation_members WHERE left_at IS NULL GROUP BY conversation_id
        ),
        doomed AS (
          SELECT m.conversation_id, m.seq FROM mailbox_messages m
          JOIN floor f ON f.conversation_id = m.conversation_id AND m.seq <= f.acked
          LIMIT ${SWEEP_BATCH}
        )
        DELETE FROM mailbox_messages m USING doomed d
        WHERE m.conversation_id = d.conversation_id AND m.seq = d.seq`.execute(this.#db);
      const n = Number(delivered.numAffectedRows ?? 0);
      total += n;
      if (n < SWEEP_BATCH) break;
    }
    const welcomes = await this.#db
      .deleteFrom('mls_welcomes')
      .where('expires_at', '<=', new Date())
      .executeTakeFirst();
    total += Number(welcomes.numDeletedRows);
    const payloads = await this.#db
      .deleteFrom('mls_welcome_payloads')
      .where((eb) =>
        eb.or([
          eb('expires_at', '<=', new Date()),
          eb.not(
            eb.exists(
              eb
                .selectFrom('mls_welcomes')
                .select('mls_welcomes.id')
                .whereRef('mls_welcomes.payload_id', '=', 'mls_welcome_payloads.id'),
            ),
          ),
        ]),
      )
      .executeTakeFirst();
    total += Number(payloads.numDeletedRows);
    if (total > 0) this.#logger.info('messaging.sweep', { count: total });
    return total;
  }

  async #hydrate(userId: string, conversationIds: readonly string[]): Promise<Conversation[]> {
    if (conversationIds.length === 0) return [];
    const conversations = await this.#db
      .selectFrom('conversations')
      .selectAll()
      .where('id', 'in', [...conversationIds])
      .execute();
    const members = await this.#db
      .selectFrom('conversation_members')
      .select(['conversation_id', 'user_id', 'acked_seq', 'role'])
      .where('conversation_id', 'in', [...conversationIds])
      .where('left_at', 'is', null)
      .execute();
    const usernames = await this.#directory.usernames([...new Set(members.map((m) => m.user_id))]);
    const byId = new Map(conversations.map((c) => [c.id, c]));
    const result: Conversation[] = [];
    for (const id of conversationIds) {
      const conversation = byId.get(id);
      const own = members.filter((m) => m.conversation_id === id);
      const me = own.find((m) => m.user_id === userId);
      // Not a member, or a deleted group: invisible.
      if (conversation === undefined || me === undefined || conversation.deleted_at !== null)
        continue;
      const peers = own.filter((m) => m.user_id !== userId);
      result.push({
        id: conversation.id,
        kind: conversation.kind,
        ciphersuite: conversation.ciphersuite,
        epoch: Number(conversation.epoch),
        lastSeq: Number(conversation.last_seq),
        lastActivityAt: conversation.last_activity_at.toISOString(),
        disappearingSeconds: conversation.disappearing_seconds,
        members: own.map((m) => ({
          userId: m.user_id,
          username: usernames.get(m.user_id) ?? 'deleted',
          role: m.role,
        })),
        ackedSeq: Number(me.acked_seq),
        peersAckedSeq: peers.length === 0 ? 0 : Math.min(...peers.map((m) => Number(m.acked_seq))),
        settings:
          conversation.kind === 'group'
            ? {
                membersCanAdd: conversation.members_can_add,
                announcementsOnly: conversation.announcements_only,
              }
            : null,
      });
    }
    return result;
  }

  async #requireMember(executor: Executor, userId: string, conversationId: string) {
    const row = await executor
      .selectFrom('conversations')
      .innerJoin('conversation_members', 'conversation_members.conversation_id', 'conversations.id')
      .select([
        'conversations.last_seq',
        'conversations.epoch',
        'conversations.disappearing_seconds',
      ])
      .where('conversations.id', '=', conversationId)
      .where('conversation_members.user_id', '=', userId)
      .where('conversation_members.left_at', 'is', null)
      .executeTakeFirst();
    // Non-members get the same answer as for non-existent conversations.
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  async #lockMembership(trx: Transaction<Database>, userId: string, conversationId: string) {
    const row = await trx
      .selectFrom('conversations')
      .innerJoin('conversation_members', 'conversation_members.conversation_id', 'conversations.id')
      .select([
        'conversations.last_seq',
        'conversations.epoch',
        'conversations.disappearing_seconds',
        'conversations.announcements_only',
        'conversations.kind',
        'conversation_members.role',
      ])
      .where('conversations.id', '=', conversationId)
      .where('conversation_members.user_id', '=', userId)
      .where('conversation_members.left_at', 'is', null)
      .where('conversations.deleted_at', 'is', null)
      .forUpdate('conversations')
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  async #memberIds(executor: Executor, conversationId: string): Promise<string[]> {
    const rows = await executor
      .selectFrom('conversation_members')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .execute();
    return rows.map((row) => row.user_id);
  }
}

function toMessage(row: {
  seq: string;
  kind: 1 | 2;
  client_message_id: string;
  sender_user_id: string;
  sender_device_id: string | null;
  epoch: string;
  ciphertext: Buffer;
  created_at: Date;
  expires_at: Date;
  commitment?: Buffer | null;
  franking_tag?: string | null;
}): MailboxMessage {
  return {
    seq: Number(row.seq),
    kind: row.kind === 2 ? 'commit' : 'application',
    clientMessageId: row.client_message_id,
    senderUserId: row.sender_user_id,
    senderDeviceId: row.sender_device_id ?? '',
    epoch: Number(row.epoch),
    ciphertext: row.ciphertext.toString('base64'),
    serverTime: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    commitment: row.commitment?.toString('base64') ?? null,
    frankingTag: row.franking_tag ?? null,
  };
}
