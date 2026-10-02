import type { GroupRole, SenderAuthority } from '../crypto/protocol.js';

import type { Attachment, MessageContent } from './content.js';

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
 *  - read markers only move forward;
 *  - groups (docs/groups.md): name/description changes only from senders whose authenticated
 *    authority allows it; pins only from admins; admins may delete others' messages (not the
 *    owner's) at any time; one vote per member per poll, latest wins.
 */

export const EDIT_WINDOW_MS = 15 * 60_000;
export const DELETE_WINDOW_MS = 48 * 60 * 60_000;

export const MAX_PINS = 20;

export type OutgoingStatus = 'sending' | 'queued' | 'sent' | 'failed';

export interface Poll {
  readonly question: string;
  readonly options: readonly string[];
  readonly multiple: boolean;
  /** Each member's current choices (option indexes). */
  readonly votes: Readonly<Record<string, readonly number[]>>;
}

export interface GroupInfo {
  readonly name: string | null;
  readonly description: string;
  /** Pinned message ids, most recent first. */
  readonly pins: readonly string[];
}

export interface TimelineMessage {
  readonly id: string;
  readonly seq: number | null;
  readonly senderId: string;
  readonly sentAt: number;
  /** Server acceptance time (authoritative for edit/delete windows); null while pending. */
  readonly serverTime: number | null;
  /** Message text, or an attachment's caption. */
  readonly text: string;
  readonly attachment: Attachment | null;
  readonly replyTo: string | null;
  readonly edited: boolean;
  readonly deleted: boolean;
  readonly reactions: Readonly<Record<string, string>>;
  /** Users mentioned in the message. */
  readonly mentions: readonly string[];
  readonly poll: Poll | null;
  /** The sender's group role when it was sent (groups only). */
  readonly authorRole: GroupRole | null;
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
  readonly group: GroupInfo;
}

export const emptyTimeline: TimelineState = {
  byId: {},
  order: [],
  readBy: {},
  maxSeq: 0,
  seenSeqs: new Set(),
  group: { name: null, description: '', pins: [] },
};

export interface IncomingEnvelope {
  readonly seq: number;
  readonly senderId: string;
  readonly serverTime: number;
  readonly content: MessageContent | null;
  /** Transport id, used when content is undecodable. */
  readonly clientMessageId: string;
  /** Authenticated group authority of the sender (groups only). */
  readonly authority?: SenderAuthority | undefined;
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
  message: {
    id: string;
    senderId: string;
    sentAt: number;
    text: string;
    replyTo: string | null;
    attachment?: Attachment | null;
    mentions?: readonly string[];
    poll?: Poll | null;
  },
): TimelineState {
  return withMessage(state, {
    ...message,
    attachment: message.attachment ?? null,
    mentions: message.mentions ?? [],
    poll: message.poll ?? null,
    authorRole: null,
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
      attachment: null,
      replyTo: null,
      edited: false,
      deleted: false,
      reactions: {},
      mentions: [],
      poll: null,
      authorRole: envelope.authority?.role ?? null,
      status: null,
      undecodable: true,
    });
  }

  const body = content.body;
  const authority = envelope.authority;
  /** Pins and similar admin actions: anyone in 1:1 conversations, admins in groups. */
  const moderator = authority?.role !== 'member';
  switch (body.kind) {
    case 'text':
    case 'media':
    case 'poll': {
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
        text:
          body.kind === 'text'
            ? body.text
            : body.kind === 'media'
              ? (body.caption ?? '')
              : body.question,
        attachment: body.kind === 'media' ? body.attachment : null,
        replyTo: body.kind === 'poll' ? null : (body.replyTo ?? null),
        edited: existing?.edited ?? false,
        deleted: existing?.deleted ?? false,
        reactions: existing?.reactions ?? {},
        mentions: body.kind === 'text' ? [...new Set(body.mentions ?? [])] : [],
        poll:
          body.kind === 'poll'
            ? {
                question: body.question,
                options: body.options,
                multiple: body.multiple,
                votes: existing?.poll?.votes ?? {},
              }
            : null,
        authorRole: authority?.role ?? null,
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
      if (target?.serverTime == null) return base;
      const own =
        target.senderId === envelope.senderId &&
        envelope.serverTime - target.serverTime <= DELETE_WINDOW_MS;
      // Group moderation: admins remove others' messages, except the owner's.
      const moderated =
        authority !== undefined &&
        target.senderId !== envelope.senderId &&
        (authority.role === 'owner' ||
          (authority.role === 'admin' && target.authorRole !== 'owner'));
      if (!own && !moderated) return base;
      return withMessage(
        base,
        { ...target, text: '', attachment: null, deleted: true, reactions: {}, poll: null },
        { group: { ...base.group, pins: base.group.pins.filter((id) => id !== target.id) } },
      );
    }
    case 'group_info': {
      if (authority === undefined) return base;
      const allowed = body.snapshot === true ? base.group.name === null : authority.editInfo;
      if (!allowed) return base;
      return {
        ...base,
        group: { ...base.group, name: body.name, description: body.description },
      };
    }
    case 'group_members':
      // Read by the encryption session (group-intents.ts), not shown in the timeline.
      return base;
    case 'pin': {
      const target = base.byId[body.target];
      if (!moderator || target === undefined || target.deleted) return base;
      const rest = base.group.pins.filter((id) => id !== body.target);
      const pins = body.pinned ? [body.target, ...rest].slice(0, MAX_PINS) : rest;
      return { ...base, group: { ...base.group, pins } };
    }
    case 'vote': {
      const target = base.byId[body.target];
      const poll = target?.poll;
      if (target === undefined || poll == null || target.deleted) return base;
      const choices = [...new Set(body.choices)].filter((c) => c < poll.options.length).sort();
      if (!poll.multiple && choices.length > 1) return base;
      const votes = Object.fromEntries(
        Object.entries(poll.votes).filter(([userId]) => userId !== envelope.senderId),
      );
      if (choices.length > 0) votes[envelope.senderId] = choices;
      return withMessage(base, { ...target, poll: { ...poll, votes } });
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
