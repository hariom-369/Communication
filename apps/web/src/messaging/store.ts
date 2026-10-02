import { newId } from '@tessera/shared';
import {
  MLS_CIPHERSUITE,
  type Conversation,
  type MailboxMessage,
  type ServerFrame,
} from '@tessera/validation';

import { ApiError } from '../api/client.js';
import type { endpoints as Endpoints } from '../api/endpoints.js';
import type { HistoryRecord, IngestResult } from '../crypto/protocol.js';

import { backoffDelay } from './backoff.js';
import {
  contentSchema,
  type Attachment,
  type MessageBody,
  type MessageContent,
} from './content.js';
import type { MediaTransfer } from './media-transfer.js';
import { SecurityBlocked, type ConversationSecurity, type DeviceStatus } from './e2ee.js';
import type { SafetyNumber } from '../crypto/protocol.js';
import { RealtimeClient, type ConnectionStatus } from './realtime-client.js';
import {
  addPending,
  applyIncoming,
  emptyTimeline,
  setStatus,
  type IncomingEnvelope,
  type TimelineState,
} from './timeline.js';

/**
 * Client messaging state (docs/messaging.md §2–§4) on top of end-to-end encryption:
 * - history lives on this device (decrypted, in the encrypted local store); the server only
 *   relays ciphertext until it is acknowledged;
 * - catch-up on every (re)connect: `GET /sync`, then every message after this device's cursor is
 *   processed strictly in sequence order (MLS requires commits before later messages);
 * - outbox: messages are encrypted on each attempt and keep their client id across retries
 *   (server idempotency). Epoch conflicts trigger a catch-up and an immediate retry; other network
 *   and server errors retry with jittered backoff; security blocks wait for the user;
 * - delivery acknowledgements after messages are stored locally; read markers are sent as
 *   encrypted control messages only if the user shares read receipts.
 */

type Api = Pick<
  typeof Endpoints,
  | 'realtimeTicket'
  | 'conversations'
  | 'conversation'
  | 'sync'
  | 'messages'
  | 'ack'
  | 'sendMessage'
  | 'openDirect'
  | 'setDisappearing'
>;

/** What the store needs from the end-to-end encryption session (see E2eeSession). */
export interface SecurityPort {
  readonly status: DeviceStatus;
  readonly deviceId: string | null;
  subscribe(listener: () => void): () => void;
  security(conversationId: string): ConversationSecurity;
  start(): Promise<void>;
  stop(): void;
  prepare(meta: Conversation, force?: boolean): Promise<void>;
  encrypt(
    meta: Conversation,
    content: string,
  ): Promise<{ ciphertext: string; epoch: number; senderDeviceId: string }>;
  ingest(meta: Conversation, message: MailboxMessage): Promise<IngestResult>;
  recordOwn(conversationId: string, record: HistoryRecord): Promise<void>;
  history(conversationId: string): Promise<HistoryRecord[]>;
  cursor(conversationId: string): Promise<number>;
  processWelcomes(): Promise<string[]>;
  keysChanged(userId: string): Promise<void>;
  // User-facing verification and recovery.
  safetyNumber(userId: string): Promise<SafetyNumber>;
  setVerified(conversationId: string, userId: string, verified: boolean): Promise<void>;
  acknowledgeChange(conversationId: string, userId: string): Promise<void>;
  dismissNewDevices(conversationId: string): void;
  resetIdentity(
    withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>,
  ): Promise<boolean>;
}

export interface ConversationView {
  readonly meta: Conversation;
  readonly timeline: TimelineState;
  readonly typing: readonly string[];
  readonly unread: number;
  /** My local read position (independent of whether read receipts are shared). */
  readonly readUpTo: number;
  readonly security: ConversationSecurity;
  /** Messages waiting because of a security condition the user must resolve. */
  readonly blocked: SecurityBlocked['reason'] | null;
}

export interface SearchResult {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly sentAt: number;
  readonly text: string;
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** A file ready to send: already processed on this device (metadata stripped, previews made). */
export interface OutgoingAttachment {
  readonly file: Blob;
  readonly info: Omit<Attachment, 'media'>;
}

export interface UploadProgress {
  /** 0–1; null until encryption finished and the upload started. */
  readonly fraction: number | null;
  readonly name: string;
  readonly category: Attachment['category'];
  readonly size: number;
  readonly failed: boolean;
}

interface MediaJob {
  readonly conversationId: string;
  readonly attachment: OutgoingAttachment;
  readonly caption: string;
  readonly replyTo: string | null;
  readonly sentAt: number;
  controller: AbortController;
}

export interface MessagingSnapshot {
  readonly status: ConnectionStatus;
  readonly device: DeviceStatus;
  readonly conversations: readonly ConversationView[];
  readonly loaded: boolean;
  readonly error: string | null;
  /** Attachments being encrypted and uploaded, by message id. */
  readonly uploads: Readonly<Record<string, UploadProgress>>;
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
  /** Highest sequence number processed by this device. */
  processedSeq: number;
  typing: Map<string, number>;
  readUpTo: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
  ackedLocally: number;
  blocked: SecurityBlocked['reason'] | null;
  hydrated: Promise<void> | null;
}

const TYPING_TTL_MS = 6000;
const OUTBOX_GIVE_UP_MS = 24 * 60 * 60_000;
const ACK_DELAY_MS = 150;
const MAX_CONFLICT_RETRIES = 3;

export interface StoreOptions {
  readonly api: Api;
  readonly security: SecurityPort;
  readonly me: { readonly id: string };
  /** Encrypted attachment upload (absent: sending attachments is unavailable). */
  readonly media?: Pick<MediaTransfer, 'upload'>;
  readonly createRealtime?: (
    options: ConstructorParameters<typeof RealtimeClient>[0],
  ) => Pick<RealtimeClient, 'start' | 'stop' | 'sendTyping' | 'reconnectNow' | 'interrupt'>;
}

function parseContent(json: string | null): MessageContent | null {
  if (json === null) return null;
  try {
    const parsed = contentSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function envelope(record: HistoryRecord): IncomingEnvelope {
  const content = parseContent(record.content);
  return {
    seq: record.seq,
    senderId: record.senderUserId,
    serverTime: Date.parse(record.serverTime),
    clientMessageId: record.clientMessageId,
    // Content must carry the transport id; anything else is treated as undecodable.
    content: content?.id === record.clientMessageId ? content : null,
  };
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
  #catchUpAgain = false;
  /** Per-conversation ingestion chains: messages are processed strictly in order. */
  readonly #ingesting = new Map<string, Promise<void>>();
  /** Read receipts are withheld until the user's privacy setting is known (privacy by default). */
  #shareReadReceipts = false;
  #typingSweep: ReturnType<typeof setInterval> | null = null;
  #unsubscribeSecurity: (() => void) | null = null;
  #started = false;
  readonly #mediaJobs = new Map<string, MediaJob>();
  readonly #uploads = new Map<string, UploadProgress>();
  /** Realtime connected and conversations loaded (the device is set up). */
  #live = false;

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

  get security(): SecurityPort {
    return this.#options.security;
  }

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
          typing: [...c.typing.entries()]
            .filter(([, until]) => until > now)
            .map(([userId]) => userId),
          unread,
          readUpTo: c.readUpTo,
          security: this.#options.security.security(c.meta.id),
          blocked: c.blocked,
        };
      })
      .sort((a, b) => Date.parse(b.meta.lastActivityAt) - Date.parse(a.meta.lastActivityAt));
    return {
      status: this.#status,
      device: this.#options.security.status,
      conversations,
      loaded: this.#loaded,
      error: this.#error,
      uploads: Object.fromEntries(this.#uploads),
    };
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.#unsubscribeSecurity = this.#options.security.subscribe(() => {
      // The device finished setting up (linked, restored or new key): start messaging.
      if (this.#started && !this.#live && this.#options.security.status === 'ready')
        void this.resume();
      this.#emit();
    });
    this.#started = true;
    this.#typingSweep = setInterval(() => {
      this.#emit();
    }, 2000);
    await this.#options.security.start();
    this.#emit();
    await this.resume();
  }

  /** After the device was set up (e.g. identity reset), start messaging. */
  async resume(): Promise<void> {
    this.#emit();
    if (this.#options.security.status !== 'ready' || this.#live) return;
    this.#live = true;
    this.#realtime.start();
    await this.#loadConversations();
  }

  stop(): void {
    for (const job of this.#mediaJobs.values()) job.controller.abort();
    this.#started = false;
    this.#live = false;
    this.#realtime.stop();
    this.#unsubscribeSecurity?.();
    if (this.#typingSweep !== null) clearInterval(this.#typingSweep);
    for (const entry of this.#outbox.values()) if (entry.timer !== null) clearTimeout(entry.timer);
    for (const conversation of this.#conversations.values())
      if (conversation.ackTimer !== null) clearTimeout(conversation.ackTimer);
    this.#options.security.stop();
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
      await Promise.all([...this.#conversations.values()].map((c) => this.#hydrate(c)));
      this.#loaded = true;
      this.#error = null;
    } catch {
      this.#error = 'Could not load your conversations.';
    }
    this.#emit();
    await this.#options.security.processWelcomes().catch(() => []);
    await this.catchUp();
    // Re-check every conversation's identities and group now, so key changes (including ones
    // not yet acknowledged before a reload) and verification state are shown immediately.
    await Promise.all(
      [...this.#conversations.values()].map((c) =>
        this.#options.security.prepare(c.meta).catch(() => undefined),
      ),
    );
    this.#emit();
  }

  #upsert(meta: Conversation): MutableConversation {
    const existing = this.#conversations.get(meta.id);
    if (existing !== undefined) {
      existing.meta = { ...meta, lastSeq: Math.max(meta.lastSeq, existing.meta.lastSeq) };
      return existing;
    }
    const created: MutableConversation = {
      meta,
      timeline: emptyTimeline,
      processedSeq: 0,
      typing: new Map(),
      readUpTo: meta.ackedSeq,
      ackTimer: null,
      ackedLocally: meta.ackedSeq,
      blocked: null,
      hydrated: null,
    };
    this.#conversations.set(meta.id, created);
    return created;
  }

  /** Loads this device's decrypted history for a conversation (once). */
  #hydrate(conversation: MutableConversation): Promise<void> {
    conversation.hydrated ??= (async () => {
      const [records, cursor] = await Promise.all([
        this.#options.security.history(conversation.meta.id),
        this.#options.security.cursor(conversation.meta.id),
      ]);
      let timeline = conversation.timeline;
      for (const record of records) timeline = applyIncoming(timeline, envelope(record));
      conversation.timeline = timeline;
      conversation.processedSeq = Math.max(conversation.processedSeq, cursor);
      const mine = timeline.readBy[this.#options.me.id];
      if (mine !== undefined && mine > conversation.readUpTo) conversation.readUpTo = mine;
    })();
    return conversation.hydrated;
  }

  // ---- catch-up and ingestion ------------------------------------------------------------------

  /**
   * Fetches and processes everything the server holds beyond this device's position. A request
   * made while a catch-up is running schedules one more pass afterwards (nothing is missed).
   */
  catchUp(): Promise<void> {
    if (this.#catchingUp !== null) {
      this.#catchUpAgain = true;
      return this.#catchingUp;
    }
    this.#catchingUp = (async () => {
      try {
        const { conversations } = await this.#options.api.sync();
        for (const position of conversations) {
          const conversation =
            this.#conversations.get(position.id) ??
            this.#upsert(await this.#options.api.conversation(position.id));
          await this.#hydrate(conversation);
          await this.#catchUpConversation(conversation, position.lastSeq);
        }
      } catch {
        // Offline or transient failure: the next (re)connect triggers another catch-up.
      } finally {
        this.#catchingUp = null;
      }
      if (this.#catchUpAgain) {
        this.#catchUpAgain = false;
        await this.catchUp();
      }
    })();
    return this.#catchingUp;
  }

  /** Serialises all ingestion for one conversation. */
  #serial(conversationId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#ingesting.get(conversationId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.#ingesting.set(
      conversationId,
      next.catch(() => undefined),
    );
    return next;
  }

  #catchUpConversation(conversation: MutableConversation, until: number): Promise<void> {
    return this.#serial(conversation.meta.id, async () => {
      let cursor = conversation.processedSeq;
      while (cursor < until) {
        const page = await this.#options.api.messages(conversation.meta.id, {
          after: cursor,
          limit: 100,
        });
        const advanced = await this.#ingest(conversation, page.messages);
        if (!advanced) break; // waiting for a Welcome
        const last = page.messages.at(-1);
        if (last === undefined || !page.hasMore) break;
        cursor = conversation.processedSeq;
      }
    });
  }

  /** Processes messages in order. Returns false if processing had to stop (no group yet). */
  async #ingest(
    conversation: MutableConversation,
    messages: readonly MailboxMessage[],
  ): Promise<boolean> {
    let timeline = conversation.timeline;
    let changed = false;
    let complete = true;
    for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
      if (message.seq <= conversation.processedSeq) continue;
      const result = await this.#options.security.ingest(conversation.meta, message);
      if (result.status === 'no-group') {
        complete = false;
        break;
      }
      conversation.processedSeq = message.seq;
      changed = true;
      if (
        result.status === 'application' ||
        (result.status === 'undecryptable' && message.kind === 'application')
      ) {
        timeline = applyIncoming(timeline, envelope(result.record));
        conversation.typing.delete(result.record.senderUserId);
      }
      this.#outbox.delete(message.clientMessageId);
    }
    if (!changed) return complete;
    conversation.timeline = timeline;
    const mine = timeline.readBy[this.#options.me.id];
    if (mine !== undefined && mine > conversation.readUpTo) conversation.readUpTo = mine;
    const last = messages.at(-1);
    conversation.meta = {
      ...conversation.meta,
      lastSeq: Math.max(conversation.meta.lastSeq, conversation.processedSeq),
      lastActivityAt: last?.serverTime ?? conversation.meta.lastActivityAt,
    };
    this.#scheduleAck(conversation, conversation.processedSeq);
    this.#emit();
    return complete;
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
        await this.#hydrate(conversation);
        // In order; fills any gap (missed hints while reconnecting) from the server.
        await this.#catchUpConversation(conversation, frame.message.seq);
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
          const conversation = this.#upsert(meta);
          await this.#hydrate(conversation);
          this.#emit();
          // A new conversation: set up its encryption group right away (best effort).
          void this.#options.security.prepare(meta).catch(() => undefined);
        } catch {
          // Not visible to us (e.g. removed): ignore.
        }
        return;
      }
      case 'welcome': {
        // Join first, then process everything that was waiting for the group.
        await this.#options.security.processWelcomes().catch(() => []);
        await this.catchUp();
        this.#flushOutbox();
        return;
      }
      case 'keys_changed': {
        await this.#options.security.keysChanged(frame.userId).catch(() => undefined);
        for (const conversation of this.#conversations.values()) {
          if (conversation.meta.members.some((member) => member.userId === frame.userId)) {
            await this.#options.security.prepare(conversation.meta, true).catch(() => undefined);
          }
        }
        this.#emit();
        return;
      }
      case 'link_approved':
        // For the device being linked, which polls (it has no realtime connection yet).
        return;
      case 'ack':
      case 'error':
      case 'ready':
      case 'reconnect':
        return;
    }
  }

  // ---- user actions ------------------------------------------------------------------------------

  /**
   * Searches decrypted history on this device only (docs/search.md: message content is never
   * indexed on the server). Case- and accent-insensitive substring match, newest first.
   */
  search(query: string, limit = 50): SearchResult[] {
    const needle = normalize(query.trim());
    if (needle.length < 2) return [];
    const results: SearchResult[] = [];
    for (const conversation of this.#conversations.values()) {
      for (const id of conversation.timeline.order) {
        const message = conversation.timeline.byId[id];
        if (message === undefined || message.deleted || message.undecodable) continue;
        if (!normalize(message.text).includes(needle)) continue;
        results.push({
          conversationId: conversation.meta.id,
          messageId: message.id,
          senderId: message.senderId,
          sentAt: message.sentAt,
          text: message.text,
        });
      }
    }
    return results.sort((a, b) => b.sentAt - a.sentAt).slice(0, limit);
  }

  async openDirect(username: string): Promise<string> {
    const meta = await this.#options.api.openDirect(username, MLS_CIPHERSUITE);
    const conversation = this.#upsert(meta);
    await this.#hydrate(conversation);
    this.#emit();
    void this.#options.security.prepare(meta).catch(() => undefined);
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

  /**
   * Sends an attachment (with an optional caption): encrypted in the worker, uploaded with
   * progress, then sent as an ordinary encrypted message that references it.
   */
  sendAttachment(
    conversationId: string,
    attachment: OutgoingAttachment,
    caption: string,
    replyTo: string | null,
  ): string | null {
    const conversation = this.#conversations.get(conversationId);
    if (conversation === undefined || this.#options.media === undefined) return null;
    const id = newId();
    const job: MediaJob = {
      conversationId,
      attachment,
      caption: caption.trim(),
      replyTo,
      sentAt: Date.now(),
      controller: new AbortController(),
    };
    this.#mediaJobs.set(id, job);
    conversation.timeline = addPending(conversation.timeline, {
      id,
      senderId: this.#options.me.id,
      sentAt: job.sentAt,
      text: job.caption,
      replyTo,
      // Placeholder reference until the upload finishes; never sent.
      attachment: null,
    });
    void this.#upload(id, job);
    return id;
  }

  /** Cancels an attachment that is still uploading. */
  cancelUpload(conversationId: string, id: string): void {
    const job = this.#mediaJobs.get(id);
    const conversation = this.#conversations.get(conversationId);
    if (job === undefined || conversation === undefined) return;
    job.controller.abort();
    this.#mediaJobs.delete(id);
    this.#uploads.delete(id);
    const byId = Object.fromEntries(
      Object.entries(conversation.timeline.byId).filter(([key]) => key !== id),
    );
    conversation.timeline = {
      ...conversation.timeline,
      byId,
      order: conversation.timeline.order.filter((other) => other !== id),
    };
    this.#emit();
  }

  async #upload(id: string, job: MediaJob): Promise<void> {
    const conversation = this.#conversations.get(job.conversationId);
    const media = this.#options.media;
    if (conversation === undefined || media === undefined) return;
    const progress = (fraction: number | null, failed = false) => {
      this.#uploads.set(id, {
        fraction,
        name: job.attachment.info.name,
        category: job.attachment.info.category,
        size: job.attachment.file.size,
        failed,
      });
      this.#emit();
    };
    progress(null);
    try {
      const reference = await media.upload(
        job.attachment.file,
        (fraction) => {
          progress(fraction);
        },
        job.controller.signal,
      );
      this.#uploads.delete(id);
      this.#mediaJobs.delete(id);
      const attachment: Attachment = { ...job.attachment.info, media: reference };
      const message = conversation.timeline.byId[id];
      if (message !== undefined)
        conversation.timeline = addPending(conversation.timeline, {
          id,
          senderId: message.senderId,
          sentAt: message.sentAt,
          text: message.text,
          replyTo: message.replyTo,
          attachment,
        });
      this.#enqueue(job.conversationId, {
        v: 1,
        id,
        sentAt: job.sentAt,
        body: {
          kind: 'media',
          attachment,
          ...(job.caption === '' ? {} : { caption: job.caption }),
          ...(job.replyTo === null ? {} : { replyTo: job.replyTo }),
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.#uploads.delete(id);
        return;
      }
      conversation.timeline = setStatus(conversation.timeline, id, 'failed');
      progress(null, true);
    }
  }

  retry(conversationId: string, id: string): void {
    const job = this.#mediaJobs.get(id);
    if (job !== undefined) {
      const conversation = this.#conversations.get(conversationId);
      if (conversation === undefined) return;
      job.controller = new AbortController();
      conversation.timeline = setStatus(conversation.timeline, id, 'sending');
      void this.#upload(id, job);
      return;
    }
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

  /** Re-attempts messages held back by a security condition (after the user resolved it). */
  unblock(conversationId: string): void {
    const conversation = this.#conversations.get(conversationId);
    if (conversation !== undefined) conversation.blocked = null;
    this.#emit();
    for (const entry of this.#outbox.values())
      if (entry.conversationId === conversationId && entry.timer === null)
        void this.#attempt(entry);
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
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      void this.#attempt(entry);
    }
  }

  async #attempt(entry: OutboxEntry, conflicts = 0): Promise<void> {
    const conversation = this.#conversations.get(entry.conversationId);
    if (conversation === undefined || !this.#outbox.has(entry.id)) return;
    entry.attempts += 1;
    try {
      const json = JSON.stringify(entry.content);
      const encrypted = await this.#options.security.encrypt(conversation.meta, json);
      const body = entry.content.body;
      const result = await this.#options.api.sendMessage(entry.conversationId, {
        clientMessageId: entry.id,
        senderDeviceId: encrypted.senderDeviceId,
        epoch: encrypted.epoch,
        ciphertext: encrypted.ciphertext,
        ...(body.kind === 'media' ? { attachments: [body.attachment.media.blobId] } : {}),
      });
      conversation.blocked = null;
      const record: HistoryRecord = {
        seq: result.seq,
        senderUserId: this.#options.me.id,
        senderDeviceId: encrypted.senderDeviceId,
        serverTime: result.serverTime,
        clientMessageId: entry.id,
        content: json,
      };
      await this.#options.security.recordOwn(entry.conversationId, record);
      this.#outbox.delete(entry.id);
      conversation.timeline = applyIncoming(conversation.timeline, envelope(record));
      conversation.meta = {
        ...conversation.meta,
        lastSeq: Math.max(conversation.meta.lastSeq, result.seq),
        lastActivityAt: result.serverTime,
      };
      this.#emit();
    } catch (error) {
      if (error instanceof SecurityBlocked) {
        // Waits for the user (key change) or for the other side (setup / Welcome).
        conversation.blocked = error.reason;
        conversation.timeline = setStatus(conversation.timeline, entry.id, 'queued');
        this.#emit();
        if (error.reason !== 'key-changed') this.#retryLater(entry);
        return;
      }
      if (
        error instanceof ApiError &&
        error.problem.status === 409 &&
        conflicts < MAX_CONFLICT_RETRIES
      ) {
        // The group changed (a commit landed first): process it, then re-encrypt.
        await this.#catchUpConversation(conversation, Number.MAX_SAFE_INTEGER).catch(
          () => undefined,
        );
        await this.#attempt(entry, conflicts + 1);
        return;
      }
      const retryable =
        !(error instanceof ApiError) ||
        error.problem.status >= 500 ||
        error.problem.status === 429 ||
        error.problem.status === 408 ||
        error.problem.status === 409;
      const expired = Date.now() - entry.createdAt > OUTBOX_GIVE_UP_MS;
      if (!retryable || expired) {
        this.#outbox.delete(entry.id);
        conversation.timeline = setStatus(conversation.timeline, entry.id, 'failed');
        // Keep failed text and media messages retryable by the user.
        if (entry.content.body.kind === 'text' || entry.content.body.kind === 'media')
          this.#outbox.set(entry.id, { ...entry, timer: null });
        this.#emit();
        return;
      }
      conversation.timeline = setStatus(conversation.timeline, entry.id, 'queued');
      this.#emit();
      this.#retryLater(
        entry,
        error instanceof ApiError && error.problem.retryAfterSeconds !== undefined
          ? error.problem.retryAfterSeconds * 1000
          : undefined,
      );
    }
  }

  #retryLater(entry: OutboxEntry, delayMs?: number): void {
    const delay = delayMs ?? backoffDelay(entry.attempts, { baseMs: 1000, capMs: 60_000 });
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#attempt(entry);
    }, delay);
  }
}
