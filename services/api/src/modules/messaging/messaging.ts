import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  DEV_PLAINTEXT_CIPHERSUITE,
  type Conversation,
  type MailboxMessage,
} from '@tessera/validation';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
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
 * The server never interprets `ciphertext`.
 */

export interface MessagingConfig {
  /** Accept ciphersuite 0 (unprotected). Development only; production config forbids it. */
  readonly allowDevPlaintext: boolean;
  readonly retentionDays: number;
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

  #assertCiphersuite(ciphersuite: number): void {
    if (ciphersuite === DEV_PLAINTEXT_CIPHERSUITE && this.#config.allowDevPlaintext) return;
    // Phase 3 supports no real suites yet; MLS suites are added in Phase 4.
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
    input: { clientMessageId: string; epoch: number; ciphertext: Buffer },
  ): Promise<{ message: MailboxMessage; duplicate: boolean }> {
    const result = await this.#db.transaction().execute(async (trx) => {
      const conversation = await this.#lockMembership(trx, userId, conversationId);
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
          client_message_id: input.clientMessageId,
          sender_user_id: userId,
          epoch: input.epoch,
          ciphertext: input.ciphertext,
          created_at: now,
          expires_at: new Date(now.getTime() + ttlMs),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
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
    }
    return { message, duplicate: result.duplicate };
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
    const conversation = await this.#requireMember(this.#db, userId, conversationId);
    if (seq > Number(conversation.last_seq))
      throw new AppError('BAD_REQUEST', { detail: 'Unknown sequence number.' });
    const updated = await this.#db
      .updateTable('conversation_members')
      .set({ acked_seq: seq })
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .where('acked_seq', '<', String(seq))
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) {
      const members = await this.#memberIds(this.#db, conversationId);
      this.#publisher.publish(members, { type: 'receipt', conversationId, userId, seq });
    }
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

  /** True if the two users share an active conversation ("contacts" for privacy purposes). */
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
      .select(['conversation_id', 'user_id', 'acked_seq'])
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
      if (conversation === undefined || me === undefined) continue; // not a member: invisible
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
        })),
        ackedSeq: Number(me.acked_seq),
        peersAckedSeq: peers.length === 0 ? 0 : Math.min(...peers.map((m) => Number(m.acked_seq))),
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
      ])
      .where('conversations.id', '=', conversationId)
      .where('conversation_members.user_id', '=', userId)
      .where('conversation_members.left_at', 'is', null)
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
  client_message_id: string;
  sender_user_id: string;
  epoch: string;
  ciphertext: Buffer;
  created_at: Date;
  expires_at: Date;
}): MailboxMessage {
  return {
    seq: Number(row.seq),
    clientMessageId: row.client_message_id,
    senderUserId: row.sender_user_id,
    epoch: Number(row.epoch),
    ciphertext: row.ciphertext.toString('base64'),
    serverTime: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
