import { newId } from '@tessera/shared';
import type { Conversation, MailboxMessage, ServerFrame } from '@tessera/validation';

import { ApiError } from '../api/client.js';
import type { endpoints as Endpoints } from '../api/endpoints.js';

import { backoffDelay } from './backoff.js';
import type { MessageBody, MessageCodec, MessageContent } from './content.js';
import { RealtimeClient, type ConnectionStatus } from './realtime-client.js';
import {
  addPending,
  applyIncoming,
  emptyTimeline,
  setStatus,
  type TimelineState,
} from './timeline.js';

/**
 * Client messaging state (docs/messaging.md §2–§4):
 * - catch-up on every (re)connect: `GET /sync`, then fetch what is missing per conversation;
 * - outbox: each message keeps its client id across retries (server-side idempotency), network
 *   and server errors retry with jittered backoff, other rejections fail visibly;
 * - delivery acknowledgements after messages are stored locally; read markers are sent as
 *   protected control messages only if the user shares read receipts.
 * History lives in memory for now; the encrypted on-device store arrives with E2EE (Phase 4).
 */

type Api = typeof Endpoints;

export interface ConversationView {
  readonly meta: Conversation;
  readonly timeline: TimelineState;
  /** Oldest sequence number the server still holds; older history exists only on devices. */
  readonly earliestAvailableSeq: number;
  readonly hasOlder: boolean;
  readonly typing: readonly string[];
  readonly unread: number;
  /** My local read position (independent of whether read receipts are shared). */
  readonly readUpTo: number;
}

export interface MessagingSnapshot {
  readonly status: ConnectionStatus;
  readonly conversations: readonly ConversationView[];
  readonly loaded: boolean;
  readonly error: string | null;
}

interface OutboxEntry {
  readonly conversationId: string;
  readonly id: string;
  readonly content: MessageContent;
  readonly createdAt: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface MutableConversation {
  meta: Conversation;
  timeline: TimelineState;
  earliestAvailableSeq: number;
  hasOlder: boolean;
  typing: Map<string, number>;
  readUpTo: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
  ackedLocally: number;
}

const TYPING_TTL_MS = 6000;
const OUTBOX_GIVE_UP_MS = 24 * 60 * 60_000;
const ACK_DELAY_MS = 150;

export interface StoreOptions {
  readonly api: Api;
  readonly codec: MessageCodec;
  readonly me: { readonly id: string };
  readonly createRealtime?: (
    options: ConstructorParameters<typeof RealtimeClient>[0],
  ) => Pick<RealtimeClient, 'start' | 'stop' | 'sendTyping' | 'reconnectNow' | 'interrupt'>;
}

export class MessagingStore {
  readonly #options: StoreOptions;
  readonly #conversations = new Map<string, MutableConversation>();
  readonly #outbox = new Map<string, OutboxEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #realtime: Pick<
    RealtimeClient,
    'start' | 'stop' | 'sendTyping' | 'reconnectNow' | 'interrupt'
  >;
  #status: ConnectionStatus = 'connecting';
  #loaded = false;
  #error: string | null = null;
  #snapshot: MessagingSnapshot;
  #catchingUp: Promise<void> | null = null;
  /** Read receipts are withheld until the user's privacy setting is known (privacy by default). */
  #shareReadReceipts = false;
  #typingSweep: ReturnType<typeof setInterval> | null = null;

  constructor(options: StoreOptions) {
    this.#options = options;
    const create = options.createRealtime ?? ((o) => new RealtimeClient(o));
    this.#realtime = create({
      getTicket: () => options.api.realtimeTicket(),
      onFrame: (frame) => {
        void this.#onFrame(frame);
      },
      onStatus: (status) => {
        this.#status = status;
        this.#emit();
      },
      onReady: () => {
        void this.catchUp();
        this.#flushOutbox();
      },
    });
    this.#snapshot = this.#buildSnapshot();
  }

  // ---- React integration -----------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): MessagingSnapshot => this.#snapshot;

  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): MessagingSnapshot {
    const now = Date.now();
    const conversations = [...this.#conversations.values()]
      .map((c): ConversationView => {
        let unread = 0;
        for (const id of c.timeline.order) {
          const message = c.timeline.byId[id];
          if (
            message?.seq != null &&
            message.seq > c.readUpTo &&
            message.senderId !== this.#options.me.id &&
            !message.deleted
          )
            unread += 1;
        }
        return {
          meta: c.meta,
          timeline: c.timeline,
          earliestAvailableSeq: c.earliestAvailableSeq,
          hasOlder: c.hasOlder,
          typing: [...c.typing.entries()]
            .filter(([, until]) => until > now)
            .map(([userId]) => userId),
          unread,
          readUpTo: c.readUpTo,
        };
      })
      .sort((a, b) => Date.parse(b.meta.lastActivityAt) - Date.parse(a.meta.lastActivityAt));
    return { status: this.#status, conversations, loaded: this.#loaded, error: this.#error };
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.#realtime.start();
    this.#typingSweep = setInterval(() => {
      this.#emit();
    }, 2000);
    await this.#loadConversations();
  }

  stop(): void {
    this.#realtime.stop();
    if (this.#typingSweep !== null) clearInterval(this.#typingSweep);
    for (const entry of this.#outbox.values()) if (entry.timer !== null) clearTimeout(entry.timer);
    for (const conversation of this.#conversations.values())
      if (conversation.ackTimer !== null) clearTimeout(conversation.ackTimer);
  }

  /** Applies the user's "send read receipts" privacy setting. */
  setShareReadReceipts(share: boolean): void {
    this.#shareReadReceipts = share;
  }

  /** Browser regained connectivity: reconnect and retry queued messages now. */
  online(): void {
    this.#realtime.reconnectNow();
    this.#flushOutbox();
  }

  /** Browser lost connectivity: show it immediately instead of waiting for a heartbeat timeout. */
  offline(): void {
    this.#realtime.interrupt();
  }

  async #loadConversations(): Promise<void> {
    try {
      let cursor: string | undefined;
      do {
        const page = await this.#options.api.conversations(cursor);
        for (const meta of page.conversations) this.#upsert(meta);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      this.#loaded = true;
      this.#error = null;
    } catch {
      this.#error = 'Could not load your conversations.';
    }
    this.#emit();
    await this.catchUp();
  }

  #upsert(meta: Conversation): MutableConversation {
    const existing = this.#conversations.get(meta.id);
    if (existing !== undefined) {
      existing.meta = meta;
      return existing;
    }
    const created: MutableConversation = {
      meta,
      timeline: emptyTimeline,
      earliestAvailableSeq: 0,
      hasOlder: false,
      typing: new Map(),
      readUpTo: meta.ackedSeq,
      ackTimer: null,
      ackedLocally: meta.ackedSeq,
    };
    this.#conversations.set(meta.id, created);
    return created;
  }

  // ---- catch-up and ingestion ------------------------------------------------------------------

  /** Fetches everything the server holds that this client has not ingested yet. */
  catchUp(): Promise<void> {
    this.#catchingUp ??= (async () => {
      try {
        const { conversations } = await this.#options.api.sync();
        for (const position of conversations) {
          const conversation =
            this.#conversations.get(position.id) ??
            this.#upsert(await this.#options.api.conversation(position.id));
          await this.#fetchAfter(conversation, conversation.timeline.maxSeq, position.lastSeq);
        }
      } catch {
        // Offline or transient failure: the next (re)connect triggers another catch-up.
      } finally {
        this.#catchingUp = null;
      }
    })();
    return this.#catchingUp;
  }

  async #fetchAfter(
    conversation: MutableConversation,
    after: number,
    until: number,
  ): Promise<void> {
    let cursor = after;
    while (cursor < until) {
      const page = await this.#options.api.messages(conversation.meta.id, {
        after: cursor,
        limit: 100,
      });
      if (conversation.timeline.maxSeq === 0) {
        conversation.earliestAvailableSeq = page.earliestAvailableSeq;
      }
      await this.#ingest(conversation, page.messages);
      const last = page.messages.at(-1);
      if (last === undefined || !page.hasMore) break;
      cursor = last.seq;
    }
  }

  async loadOlder(conversationId: string): Promise<void> {
    const conversation = this.#conversations.get(conversationId);
    if (conversation === undefined) return;
    const oldest = conversation.timeline.order
      .map((id) => conversation.timeline.byId[id]?.seq)
      .find((seq): seq is number => typeof seq === 'number');
    if (oldest === undefined) return;
    const page = await this.#options.api.messages(conversationId, { before: oldest, limit: 50 });
    conversation.hasOlder = page.hasMore;
    conversation.earliestAvailableSeq = page.earliestAvailableSeq;
    await this.#ingest(conversation, page.messages);
  }

  async #ingest(
    conversation: MutableConversation,
    messages: readonly MailboxMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;
    let timeline = conversation.timeline;
    for (const message of messages) {
      const content = await this.#options.codec.decode(message.ciphertext);
      timeline = applyIncoming(timeline, {
        seq: message.seq,
        senderId: message.senderUserId,
        serverTime: Date.parse(message.serverTime),
        clientMessageId: message.clientMessageId,
        // Content must carry the transport id; anything else is treated as undecodable.
        content: content?.id === message.clientMessageId ? content : null,
      });
      this.#outbox.delete(message.clientMessageId);
      conversation.typing.delete(message.senderUserId);
    }
    conversation.timeline = timeline;
    const mine = timeline.readBy[this.#options.me.id];
    if (mine !== undefined && mine > conversation.readUpTo) conversation.readUpTo = mine;
    const maxSeq = Math.max(...messages.map((m) => m.seq));
    conversation.meta = {
      ...conversation.meta,
      lastSeq: Math.max(conversation.meta.lastSeq, maxSeq),
      lastActivityAt: messages.at(-1)?.serverTime ?? conversation.meta.lastActivityAt,
    };
    this.#scheduleAck(conversation, maxSeq);
    this.#emit();
  }

  /** Delivery acknowledgement: this device has stored the messages (coalesced). */
  #scheduleAck(conversation: MutableConversation, seq: number): void {
    if (seq <= conversation.ackedLocally) return;
    conversation.ackedLocally = seq;
    if (conversation.ackTimer !== null) return;
    conversation.ackTimer = setTimeout(() => {
      conversation.ackTimer = null;
      this.#options.api.ack(conversation.meta.id, conversation.ackedLocally).catch(() => {
        conversation.ackedLocally = Math.min(conversation.ackedLocally, conversation.meta.ackedSeq);
      });
    }, ACK_DELAY_MS);
  }

  async #onFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'message': {
        let conversation = this.#conversations.get(frame.conversationId);
        if (conversation === undefined) {
          try {
            conversation = this.#upsert(await this.#options.api.conversation(frame.conversationId));
          } catch {
            return;
          }
        }
        if (frame.message.seq > conversation.timeline.maxSeq + 1) {
          // Gap (missed hints while reconnecting): fetch in order instead of skipping ahead.
          await this.#fetchAfter(conversation, conversation.timeline.maxSeq, frame.message.seq);
        } else {
          await this.#ingest(conversation, [frame.message]);
        }
        return;
      }
      case 'receipt': {
        const conversation = this.#conversations.get(frame.conversationId);
        if (conversation === undefined) return;
        if (frame.userId === this.#options.me.id) {
          conversation.meta = {
            ...conversation.meta,
            ackedSeq: Math.max(conversation.meta.ackedSeq, frame.seq),
          };
        } else {
          conversation.meta = {
            ...conversation.meta,
            peersAckedSeq: Math.max(conversation.meta.peersAckedSeq, frame.seq),
          };
        }
        this.#emit();
        return;
      }
      case 'typing': {
        const conversation = this.#conversations.get(frame.conversationId);
        if (conversation === undefined || frame.userId === this.#options.me.id) return;
        if (frame.state === 'start')
          conversation.typing.set(frame.userId, Date.now() + TYPING_TTL_MS);
        else conversation.typing.delete(frame.userId);
        this.#emit();
        return;
      }
      case 'conversation': {
        try {
          const meta = await this.#options.api.conversation(frame.conversationId);
          this.#upsert(meta);
          this.#emit();
        } catch {
          // Not visible to us (e.g. removed): ignore.
        }
        return;
      }
      case 'ack':
      case 'error':
      case 'ready':
      case 'reconnect':
        return;
    }
  }

  // ---- user actions ------------------------------------------------------------------------------

  async openDirect(username: string): Promise<string> {
    const meta = await this.#options.api.openDirect(username, this.#options.codec.ciphersuite);
    this.#upsert(meta);
    this.#emit();
    return meta.id;
  }

  sendText(conversationId: string, text: string, replyTo: string | null): void {
    const conversation = this.#conversations.get(conversationId);
    const trimmed = text.trim();
    if (conversation === undefined || trimmed === '') return;
    const id = newId();
    const sentAt = Date.now();
    conversation.timeline = addPending(conversation.timeline, {
      id,
      senderId: this.#options.me.id,
      sentAt,
      text: trimmed,
      replyTo,
    });
    this.#emit();
    this.#enqueue(conversationId, {
      v: 1,
      id,
      sentAt,
      body:
        replyTo === null
          ? { kind: 'text', text: trimmed }
          : { kind: 'text', text: trimmed, replyTo },
    });
  }

  react(conversationId: string, target: string, emoji: string | null): void {
    this.#control(conversationId, { kind: 'reaction', target, emoji });
  }

  edit(conversationId: string, target: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed !== '') this.#control(conversationId, { kind: 'edit', target, text: trimmed });
  }

  deleteForEveryone(conversationId: string, target: string): void {
    this.#control(conversationId, { kind: 'delete', target });
  }

  /** Marks the conversation read locally; tells others only if read receipts are shared. */
  markRead(conversationId: string): void {
    const conversation = this.#conversations.get(conversationId);
    if (conversation === undefined) return;
    let latestIncoming = 0;
    for (const id of conversation.timeline.order) {
      const message = conversation.timeline.byId[id];
      if (message?.seq != null && message.senderId !== this.#options.me.id)
        latestIncoming = Math.max(latestIncoming, message.seq);
    }
    if (latestIncoming <= conversation.readUpTo) return;
    conversation.readUpTo = latestIncoming;
    this.#emit();
    if (this.#shareReadReceipts)
      this.#control(conversationId, { kind: 'read', upToSeq: latestIncoming });
  }

  retry(conversationId: string, id: string): void {
    const entry = this.#outbox.get(id);
    const conversation = this.#conversations.get(conversationId);
    if (entry === undefined || conversation === undefined) return;
    entry.attempts = 0;
    conversation.timeline = setStatus(conversation.timeline, id, 'sending');
    this.#emit();
    void this.#attempt(entry);
  }

  typing(conversationId: string, state: 'start' | 'stop'): void {
    this.#realtime.sendTyping(conversationId, state);
  }

  async setDisappearing(
    conversationId: string,
    seconds: 0 | 86400 | 604800 | 7776000,
  ): Promise<void> {
    const meta = await this.#options.api.setDisappearing(conversationId, seconds);
    this.#upsert(meta);
    this.#emit();
  }

  #control(conversationId: string, body: MessageBody): void {
    this.#enqueue(conversationId, { v: 1, id: newId(), sentAt: Date.now(), body });
  }

  // ---- outbox ------------------------------------------------------------------------------------

  #enqueue(conversationId: string, content: MessageContent): void {
    const entry: OutboxEntry = {
      conversationId,
      id: content.id,
      content,
      createdAt: Date.now(),
      attempts: 0,
      timer: null,
    };
    this.#outbox.set(entry.id, entry);
    void this.#attempt(entry);
  }

  #flushOutbox(): void {
    for (const entry of this.#outbox.values()) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
        void this.#attempt(entry);
      }
    }
  }

  async #attempt(entry: OutboxEntry): Promise<void> {
    const conversation = this.#conversations.get(entry.conversationId);
    if (conversation === undefined || !this.#outbox.has(entry.id)) return;
    entry.attempts += 1;
    try {
      const ciphertext = await this.#options.codec.encode(entry.content);
      const result = await this.#options.api.sendMessage(entry.conversationId, {
        clientMessageId: entry.id,
        epoch: conversation.meta.epoch,
        ciphertext,
      });
      if (!this.#outbox.has(entry.id)) return; // echo already ingested
      this.#outbox.delete(entry.id);
      await this.#ingest(conversation, [
        {
          seq: result.seq,
          clientMessageId: entry.id,
          senderUserId: this.#options.me.id,
          epoch: conversation.meta.epoch,
          ciphertext,
          serverTime: result.serverTime,
          expiresAt: result.serverTime,
        },
      ]);
    } catch (error) {
      const retryable =
        !(error instanceof ApiError) ||
        error.problem.status >= 500 ||
        error.problem.status === 429 ||
        error.problem.status === 408;
      const expired = Date.now() - entry.createdAt > OUTBOX_GIVE_UP_MS;
      if (!retryable || expired) {
        this.#outbox.delete(entry.id);
        conversation.timeline = setStatus(conversation.timeline, entry.id, 'failed');
        // Keep failed text messages retryable by the user.
        if (entry.content.body.kind === 'text')
          this.#outbox.set(entry.id, { ...entry, timer: null });
        this.#emit();
        return;
      }
      conversation.timeline = setStatus(conversation.timeline, entry.id, 'queued');
      this.#emit();
      const delay =
        error instanceof ApiError && error.problem.retryAfterSeconds !== undefined
          ? error.problem.retryAfterSeconds * 1000
          : backoffDelay(entry.attempts, { baseMs: 1000, capMs: 60_000 });
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void this.#attempt(entry);
      }, delay);
    }
  }
}
