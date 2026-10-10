import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  CALL_HEARTBEAT_SECONDS,
  CALL_RING_SECONDS,
  MAX_SFU_PARTICIPANTS,
  type CallRecord,
  type IceConfig,
  type PrivacySettings,
  type StartCall,
} from '@tessera/validation';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import type { CallsTable, Database } from '../../db/schema.js';
import type { RealtimePublisher } from '../../platform/realtime-publisher.js';

import type { LiveKitConfig, SfuRooms } from './sfu.js';
import { iceConfig, type TurnConfig } from './turn.js';

/**
 * Call control plane (docs/calling.md §1–§2, ADR-016/017/047). The server learns that a call
 * happened, between which devices, and for how long — never what was said or shown, and never
 * the signalling (offers, answers and network candidates are end-to-end encrypted messages).
 */

export interface CallConversations {
  callContext(
    conversationId: string,
  ): Promise<{ kind: 'direct' | 'group'; memberIds: string[] } | null>;
  areContacts(a: string, b: string): Promise<boolean>;
}

/** Blocks (docs/moderation.md §2): no calls between people where either blocked the other. */
export interface CallBlocks {
  blockedEitherWay(a: string, b: string): Promise<boolean>;
}

export interface CallDevices {
  isActiveDevice(userId: string, deviceId: string): Promise<boolean>;
}

export interface CallDirectory {
  privacySettings(userId: string): Promise<PrivacySettings>;
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
}

/** Wakes devices that are not connected when a call rings (docs/notifications.md §1). */
export interface CallNotifier {
  callRinging(
    conversationId: string,
    callId: string,
    recipientIds: readonly string[],
    direct: boolean,
  ): Promise<void>;
}

export interface CallsConfig {
  readonly turn: TurnConfig | null;
  readonly stunUrls: readonly string[];
  readonly sfu: Pick<LiveKitConfig, 'url'> | null;
  readonly retentionDays: number;
}

type CallRow = Selectable<CallsTable>;
type EndReason = NonNullable<CallRow['end_reason']>;

/** A participant who has not confirmed for this long is treated as gone. */
const PARTICIPANT_TIMEOUT_MS = 3 * CALL_HEARTBEAT_SECONDS * 1000;

export class CallsService {
  readonly #db: Kysely<Database>;
  readonly #conversations: CallConversations;
  readonly #devices: CallDevices;
  readonly #directory: CallDirectory;
  readonly #publisher: RealtimePublisher;
  readonly #sfu: SfuRooms | null;
  readonly #config: CallsConfig;
  readonly #logger: Logger;
  #notifier: CallNotifier | null = null;
  #groupCallsSwitch: ((userId: string) => Promise<boolean>) | null = null;
  #blocks: CallBlocks | null = null;

  constructor(options: {
    db: Kysely<Database>;
    conversations: CallConversations;
    devices: CallDevices;
    directory: CallDirectory;
    publisher: RealtimePublisher;
    sfu: SfuRooms | null;
    config: CallsConfig;
    logger: Logger;
  }) {
    this.#db = options.db;
    this.#conversations = options.conversations;
    this.#devices = options.devices;
    this.#directory = options.directory;
    this.#publisher = options.publisher;
    this.#sfu = options.sfu;
    this.#config = options.config;
    this.#logger = options.logger;
  }

  useBlocks(blocks: CallBlocks): void {
    this.#blocks = blocks;
  }

  useNotifier(notifier: CallNotifier): void {
    this.#notifier = notifier;
  }

  /** Kill switch for group calls (feature flag `group_calls`, admin console). */
  useSwitch(groupCalls: (userId: string) => Promise<boolean>): void {
    this.#groupCallsSwitch = groupCalls;
  }

  async capabilities(
    userId?: string,
  ): Promise<{ relayAvailable: boolean; groupCallsAvailable: boolean }> {
    const configured = this.#sfu !== null && this.#config.sfu !== null;
    return {
      relayAvailable: this.#config.turn !== null,
      groupCallsAvailable:
        configured &&
        (this.#groupCallsSwitch === null ||
          userId === undefined ||
          (await this.#groupCallsSwitch(userId))),
    };
  }

  ice(): IceConfig {
    return iceConfig(this.#config.turn, this.#config.stunUrls);
  }

  // ---- lifecycle ---------------------------------------------------------------------------------

  /** Starts a call, or returns the call already going on in the conversation (`created: false`). */
  async start(
    userId: string,
    input: StartCall,
  ): Promise<{ call: CallRecord; created: boolean; ice: IceConfig }> {
    await this.#requireDevice(userId, input.deviceId);
    const context = await this.#context(userId, input.conversationId);
    const mode = context.kind === 'direct' ? 'p2p' : 'sfu';
    if (mode === 'sfu' && !(await this.capabilities(userId)).groupCallsAvailable)
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Group calls are not available on this server.',
      });
    if (mode === 'p2p') {
      const peer = context.memberIds.find((id) => id !== userId);
      if (peer === undefined)
        throw new AppError('CONFLICT', { detail: 'There is nobody else in this conversation.' });
      await this.#requireAcceptsCalls(userId, peer);
    }

    const existing = await this.#live(this.#db, input.conversationId);
    if (existing !== undefined)
      return { call: await this.#record(existing), created: false, ice: this.ice() };

    const id = newId();
    try {
      await this.#db.transaction().execute(async (trx) => {
        await trx
          .insertInto('calls')
          .values({
            id,
            conversation_id: input.conversationId,
            mode,
            media: input.media,
            initiator_user_id: userId,
            initiator_device_id: input.deviceId,
          })
          .execute();
        await trx
          .insertInto('call_participants')
          .values({ call_id: id, device_id: input.deviceId, user_id: userId })
          .execute();
      });
    } catch (error) {
      // Someone else started a call in this conversation at the same moment: join theirs.
      if ((error as { code?: string }).code !== '23505') throw error;
      const winner = await this.#live(this.#db, input.conversationId);
      if (winner === undefined) throw error;
      return { call: await this.#record(winner), created: false, ice: this.ice() };
    }
    const row = await this.#row(this.#db, id);
    this.#announce(context.memberIds, row, 'ringing');
    // Not awaited: a large group must not delay the caller; failures are logged by the notifier.
    void this.#notifier?.callRinging(
      input.conversationId,
      id,
      context.memberIds.filter((member) => member !== userId),
      context.kind === 'direct',
    );
    return { call: await this.#record(row), created: true, ice: this.ice() };
  }

  async join(
    userId: string,
    callId: string,
    deviceId: string,
  ): Promise<{ call: CallRecord; ice: IceConfig; sfu: { url: string; token: string } | null }> {
    await this.#requireDevice(userId, deviceId);
    const row = await this.#visible(userId, callId);
    if (row.ended_at !== null) throw new AppError('CONFLICT', { detail: 'This call has ended.' });
    const context = await this.#context(userId, row.conversation_id);
    if (row.mode === 'p2p' && userId !== row.initiator_user_id) {
      await this.#requireAcceptsCalls(row.initiator_user_id, userId);
    }

    const answered = await this.#db.transaction().execute(async (trx) => {
      // Serialise joins of one call so the participant limit and "answered" are exact.
      await trx.selectFrom('calls').select('id').where('id', '=', callId).forUpdate().execute();
      const current = await this.#participants(trx, callId);
      const already = current.some((p) => p.device_id === deviceId);
      const limit = row.mode === 'p2p' ? 2 : MAX_SFU_PARTICIPANTS;
      if (!already && current.length >= limit)
        throw new AppError('CONFLICT', { detail: 'This call is full.' });
      await trx
        .insertInto('call_participants')
        .values({ call_id: callId, device_id: deviceId, user_id: userId })
        .onConflict((oc) =>
          oc.columns(['call_id', 'device_id']).doUpdateSet({ last_seen_at: new Date() }),
        )
        .execute();
      const count = already ? current.length : current.length + 1;
      const firstAnswer = row.answered_at === null && userId !== row.initiator_user_id;
      await trx
        .updateTable('calls')
        .set({
          peak_participants: sql<number>`greatest(peak_participants, ${count})`,
          ...(firstAnswer ? { answered_at: new Date() } : {}),
        })
        .where('id', '=', callId)
        .execute();
      return firstAnswer;
    });
    const updated = await this.#row(this.#db, callId);
    if (answered) this.#announce(context.memberIds, updated, 'active');

    let sfu: { url: string; token: string } | null = null;
    if (row.mode === 'sfu') {
      if (this.#sfu === null || this.#config.sfu === null)
        throw new AppError('SERVICE_UNAVAILABLE', {
          detail: 'Group calls are not available on this server.',
        });
      sfu = { url: this.#config.sfu.url, token: await this.#sfu.token(callId, deviceId) };
    }
    return { call: await this.#record(updated), ice: this.ice(), sfu };
  }

  /**
   * This device leaves. A 1:1 call ends when either side leaves (or declines); a group call ends
   * when its last participant leaves.
   */
  async leave(
    userId: string,
    callId: string,
    deviceId: string,
    reason: EndReason,
  ): Promise<CallRecord> {
    const row = await this.#visible(userId, callId);
    if (row.ended_at !== null) return this.#record(row);
    await this.#db
      .deleteFrom('call_participants')
      .where('call_id', '=', callId)
      .where('device_id', '=', deviceId)
      .where('user_id', '=', userId)
      .execute();
    const remaining = await this.#participants(this.#db, callId);
    if (row.mode === 'p2p') {
      // Unanswered and the caller gave up: the other side missed it.
      const why =
        row.answered_at === null && userId === row.initiator_user_id && reason === 'hangup'
          ? 'missed'
          : reason;
      await this.#end(row, why);
    } else if (remaining.length === 0) await this.#end(row, 'hangup');
    else if (this.#sfu !== null) {
      void this.#sfu.removeParticipant(callId, deviceId).catch(() => undefined);
    }
    return this.#record(await this.#row(this.#db, callId));
  }

  /** Confirms this device is still in the call; NOT_FOUND tells it to leave. */
  async heartbeat(userId: string, callId: string, deviceId: string): Promise<void> {
    const row = await this.#visible(userId, callId);
    const updated = await this.#db
      .updateTable('call_participants')
      .set({ last_seen_at: new Date() })
      .where('call_id', '=', callId)
      .where('device_id', '=', deviceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row.ended_at !== null || Number(updated.numUpdatedRows) === 0)
      throw new AppError('NOT_FOUND', { detail: 'You are no longer in this call.' });
  }

  async get(userId: string, callId: string): Promise<CallRecord> {
    return this.#record(await this.#visible(userId, callId));
  }

  async active(userId: string, conversationId: string): Promise<CallRecord | null> {
    await this.#context(userId, conversationId);
    const row = await this.#live(this.#db, conversationId);
    return row === undefined ? null : this.#record(row);
  }

  /**
   * Housekeeping (singleton task): stops ringing nobody answered, drops participants who went
   * silent or are no longer in the conversation, ends abandoned calls, deletes old records.
   */
  async sweep(now = new Date()): Promise<{ ended: number; dropped: number; deleted: number }> {
    let ended = 0;
    let dropped = 0;
    const live = await this.#db
      .selectFrom('calls')
      .selectAll()
      .where('ended_at', 'is', null)
      .orderBy('started_at')
      .limit(1000)
      .execute();
    for (const row of live) {
      if (
        row.answered_at === null &&
        now.getTime() - row.started_at.getTime() > CALL_RING_SECONDS * 1000
      ) {
        await this.#end(row, 'missed');
        ended += 1;
        continue;
      }
      const context = await this.#conversations.callContext(row.conversation_id);
      const members = new Set(context?.memberIds ?? []);
      const participants = await this.#participants(this.#db, row.id);
      let gone = 0;
      for (const participant of participants) {
        const silent = now.getTime() - participant.last_seen_at.getTime() > PARTICIPANT_TIMEOUT_MS;
        if (!silent && members.has(participant.user_id)) continue;
        await this.#db
          .deleteFrom('call_participants')
          .where('call_id', '=', row.id)
          .where('device_id', '=', participant.device_id)
          .execute();
        gone += 1;
        if (row.mode === 'sfu' && this.#sfu !== null) {
          await this.#sfu
            .removeParticipant(row.id, participant.device_id)
            .catch((error: unknown) => {
              this.#logger.warn('calls.sfu_remove_failed', this.#logger.errorFields(error));
            });
        }
      }
      dropped += gone;
      const remaining = participants.length - gone;
      const needed = row.mode === 'p2p' && row.answered_at !== null ? 2 : 1;
      if (context === null || remaining < needed) {
        await this.#end(row, context === null ? 'removed' : 'hangup');
        ended += 1;
      }
    }
    const cutoff = new Date(now.getTime() - this.#config.retentionDays * 24 * 3_600_000);
    const deleted = await this.#db
      .deleteFrom('calls')
      .where('ended_at', '<', cutoff)
      .executeTakeFirst();
    return { ended, dropped, deleted: Number(deleted.numDeletedRows) };
  }

  // ---- helpers -----------------------------------------------------------------------------------

  async #end(row: CallRow, reason: EndReason): Promise<void> {
    const result = await this.#db
      .updateTable('calls')
      .set({ ended_at: new Date(), end_reason: reason })
      .where('id', '=', row.id)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) return; // someone else ended it first
    await this.#db.deleteFrom('call_participants').where('call_id', '=', row.id).execute();
    const context = await this.#conversations.callContext(row.conversation_id);
    if (context !== null) this.#announce(context.memberIds, row, 'ended');
    if (row.mode === 'sfu' && this.#sfu !== null) {
      await this.#sfu.closeRoom(row.id).catch((error: unknown) => {
        this.#logger.warn('calls.sfu_close_failed', this.#logger.errorFields(error));
      });
    }
  }

  #announce(memberIds: readonly string[], row: CallRow, state: 'ringing' | 'active' | 'ended') {
    this.#publisher.publish(memberIds, {
      type: 'call',
      conversationId: row.conversation_id,
      callId: row.id,
      state,
      mode: row.mode,
    });
  }

  async #requireDevice(userId: string, deviceId: string): Promise<void> {
    if (!(await this.#devices.isActiveDevice(userId, deviceId)))
      throw new AppError('FORBIDDEN', { detail: 'This device is not registered for encryption.' });
  }

  /** The conversation, if the user is in it; NOT_FOUND otherwise (no existence oracle). */
  async #context(userId: string, conversationId: string) {
    const context = await this.#conversations.callContext(conversationId);
    if (!context?.memberIds.includes(userId)) throw new AppError('NOT_FOUND');
    return context;
  }

  /** "Who can call me" (privacy settings), checked for 1:1 calls. */
  async #requireAcceptsCalls(caller: string, callee: string): Promise<void> {
    const settings = await this.#directory.privacySettings(callee);
    const blocked = (await this.#blocks?.blockedEitherWay(caller, callee)) === true;
    const allowed =
      !blocked &&
      (settings.calls === 'everyone' ||
        (settings.calls === 'contacts' && (await this.#conversations.areContacts(caller, callee))));
    if (!allowed) {
      const name = (await this.#directory.usernames([callee])).get(callee) ?? null;
      throw new AppError('FORBIDDEN', {
        detail: `${name === null ? 'This person' : `@${name}`} does not accept calls.`,
      });
    }
  }

  async #visible(userId: string, callId: string): Promise<CallRow> {
    const row = await this.#db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', callId)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    await this.#context(userId, row.conversation_id);
    return row;
  }

  #live(executor: Kysely<Database> | Transaction<Database>, conversationId: string) {
    return executor
      .selectFrom('calls')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
  }

  #row(executor: Kysely<Database>, callId: string): Promise<CallRow> {
    return executor
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', callId)
      .executeTakeFirstOrThrow();
  }

  #participants(executor: Kysely<Database> | Transaction<Database>, callId: string) {
    return executor
      .selectFrom('call_participants')
      .select(['device_id', 'user_id', 'last_seen_at'])
      .where('call_id', '=', callId)
      .execute();
  }

  async #record(row: CallRow): Promise<CallRecord> {
    const participantCount =
      row.ended_at === null
        ? (await this.#participants(this.#db, row.id)).length
        : row.peak_participants;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      mode: row.mode,
      media: row.media,
      state: row.ended_at !== null ? 'ended' : row.answered_at !== null ? 'active' : 'ringing',
      initiatorUserId: row.initiator_user_id,
      initiatorDeviceId: row.initiator_device_id,
      startedAt: row.started_at.toISOString(),
      answeredAt: row.answered_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      endReason: row.end_reason,
      participantCount,
    };
  }
}
