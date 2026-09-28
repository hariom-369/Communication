import type { MessageContent } from './content.js';

/**
 * Conversation timeline — a pure state machine (no I/O), so every rule is unit-testable.
 *
 * Ordering: messages accepted by the server are ordered by their sequence number; the sender's
 * own not-yet-accepted messages follow in the order they were written.
 *
 * Rules the server cannot enforce (it cannot read content), enforced by every client:
 *  - edits: only by the original sender, within EDIT_WINDOW_MS of the original;
 *  - delete for everyone: only by the original sender, within DELETE_WINDOW_MS;
 *  - reactions: one per member per message, latest wins, `null` removes;
 *  - read markers only move forward.
 */

export const EDIT_WINDOW_MS = 15 * 60_000;
export const DELETE_WINDOW_MS = 48 * 60 * 60_000;

export type OutgoingStatus = 'sending' | 'queued' | 'sent' | 'failed';

export interface TimelineMessage {
  readonly id: string;
  readonly seq: number | null;
  readonly senderId: string;
  readonly sentAt: number;
  /** Server acceptance time (authoritative for edit/delete windows); null while pending. */
  readonly serverTime: number | null;
  readonly text: string;
  readonly replyTo: string | null;
  readonly edited: boolean;
  readonly deleted: boolean;
  readonly reactions: Readonly<Record<string, string>>;
  /** Only for the local user's messages. */
  readonly status: OutgoingStatus | null;
  /** Content could not be decoded (e.g. from a newer client). */
  readonly undecodable: boolean;
}

export interface TimelineState {
  readonly byId: Readonly<Record<string, TimelineMessage>>;
  readonly order: readonly string[];
  /** Highest sequence number read by each member, from their read markers. */
  readonly readBy: Readonly<Record<string, number>>;
  /** Highest sequence number ingested (text and control messages). */
  readonly maxSeq: number;
  /** Sequence numbers already ingested (for idempotent ingestion). */
  readonly seenSeqs: ReadonlySet<number>;
}

export const emptyTimeline: TimelineState = {
  byId: {},
  order: [],
  readBy: {},
  maxSeq: 0,
  seenSeqs: new Set(),
};

export interface IncomingEnvelope {
  readonly seq: number;
  readonly senderId: string;
  readonly serverTime: number;
  readonly content: MessageContent | null;
  /** Transport id, used when content is undecodable. */
  readonly clientMessageId: string;
}

function sortOrder(byId: Readonly<Record<string, TimelineMessage>>): string[] {
  return Object.values(byId)
    .sort((a, b) => {
      if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
      if (a.seq !== null) return -1;
      if (b.seq !== null) return 1;
      return a.sentAt - b.sentAt;
    })
    .map((message) => message.id);
}

function withMessage(
  state: TimelineState,
  message: TimelineMessage,
  extra: Partial<TimelineState> = {},
): TimelineState {
  const byId = { ...state.byId, [message.id]: message };
  return { ...state, ...extra, byId, order: sortOrder(byId) };
}

/** Adds the local user's message before the server has accepted it. */
export function addPending(
  state: TimelineState,
  message: { id: string; senderId: string; sentAt: number; text: string; replyTo: string | null },
): TimelineState {
  return withMessage(state, {
    ...message,
    seq: null,
    serverTime: null,
    edited: false,
    deleted: false,
    reactions: {},
    status: 'sending',
    undecodable: false,
  });
}

export function setStatus(state: TimelineState, id: string, status: OutgoingStatus): TimelineState {
  const message = state.byId[id];
  if (message?.seq !== null) return state;
  return withMessage(state, { ...message, status });
}

/** Applies a message accepted by the server (own echo or someone else's). Idempotent per seq. */
export function applyIncoming(state: TimelineState, envelope: IncomingEnvelope): TimelineState {
  if (state.seenSeqs.has(envelope.seq)) return state;
  const seenSeqs = new Set(state.seenSeqs).add(envelope.seq);
  const base: TimelineState = { ...state, seenSeqs, maxSeq: Math.max(state.maxSeq, envelope.seq) };
  const content = envelope.content;

  if (content === null) {
    return withMessage(base, {
      id: envelope.clientMessageId,
      seq: envelope.seq,
      senderId: envelope.senderId,
      sentAt: envelope.serverTime,
      serverTime: envelope.serverTime,
      text: '',
      replyTo: null,
      edited: false,
      deleted: false,
      reactions: {},
      status: null,
      undecodable: true,
    });
  }

  const body = content.body;
  switch (body.kind) {
    case 'text': {
      const existing = base.byId[content.id];
      // Only the original sender's pending copy can be confirmed; ids are client-chosen, so an
      // id collision from another sender must not overwrite someone else's message.
      if (existing !== undefined && existing.senderId !== envelope.senderId) return base;
      return withMessage(base, {
        id: content.id,
        seq: envelope.seq,
        senderId: envelope.senderId,
        sentAt: content.sentAt,
        serverTime: envelope.serverTime,
        text: body.text,
        replyTo: body.replyTo ?? null,
        edited: existing?.edited ?? false,
        deleted: existing?.deleted ?? false,
        reactions: existing?.reactions ?? {},
        status: null,
        undecodable: false,
      });
    }
    case 'edit': {
      const target = base.byId[body.target];
      if (target?.serverTime == null || target.senderId !== envelope.senderId || target.deleted)
        return base;
      if (envelope.serverTime - target.serverTime > EDIT_WINDOW_MS) return base;
      return withMessage(base, { ...target, text: body.text, edited: true });
    }
    case 'delete': {
      const target = base.byId[body.target];
      if (target?.serverTime == null || target.senderId !== envelope.senderId) return base;
      if (envelope.serverTime - target.serverTime > DELETE_WINDOW_MS) return base;
      return withMessage(base, { ...target, text: '', deleted: true, reactions: {} });
    }
    case 'reaction': {
      const target = base.byId[body.target];
      if (target === undefined || target.deleted) return base;
      const others = Object.entries(target.reactions).filter(
        ([userId]) => userId !== envelope.senderId,
      );
      const reactions = Object.fromEntries(
        body.emoji === null ? others : [...others, [envelope.senderId, body.emoji]],
      );
      return withMessage(base, { ...target, reactions });
    }
    case 'read': {
      const upTo = Math.min(body.upToSeq, envelope.seq);
      const previous = base.readBy[envelope.senderId] ?? 0;
      if (upTo <= previous) return base;
      return { ...base, readBy: { ...base.readBy, [envelope.senderId]: upTo } };
    }
  }
}

export type DeliveryState = 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Delivery state of the local user's message for display (docs/messaging.md §1). "read" is shown
 * only when the viewer also shares read receipts (reciprocity).
 */
export function deliveryState(
  message: TimelineMessage,
  peers: { deliveredUpTo: number; readUpTo: number },
  showRead: boolean,
): DeliveryState {
  if (message.seq === null) return message.status ?? 'sending';
  if (showRead && peers.readUpTo >= message.seq) return 'read';
  if (peers.deliveredUpTo >= message.seq) return 'delivered';
  return 'sent';
}

/** Number of visible messages from others after the local user's read position. */
export function unreadCount(state: TimelineState, me: string): number {
  const readUpTo = state.readBy[me] ?? 0;
  let count = 0;
  for (const id of state.order) {
    const message = state.byId[id];
    if (
      message?.seq != null &&
      message.seq > readUpTo &&
      message.senderId !== me &&
      !message.deleted
    )
      count += 1;
  }
  return count;
}
