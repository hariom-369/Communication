import { mediaReferenceSchema } from '@tessera/validation';
import { z } from 'zod';

/**
 * Plaintext message content — what lives *inside* the ciphertext. The server never sees it.
 * Control messages (reactions, edits, deletions, read markers) are ordinary messages in the
 * conversation, so they are protected and ordered exactly like text (docs/messaging.md §6).
 *
 * Encoded as JSON inside the MLS application message, then padded to a size bucket by the crypto
 * core (docs/crypto-design.md §9; ADR-039 records why JSON rather than Protobuf for now).
 */
export const MAX_TEXT_LENGTH = 16_000;

const messageRef = z.string().min(1).max(64);

export const MEDIA_CATEGORIES = ['image', 'video', 'audio', 'voice', 'file'] as const;
/** Inline JPEG preview (base64), small enough to keep media messages under the padding cap. */
export const MAX_THUMBNAIL_CHARS = 32 * 1024;

/** An attachment inside a message: how to fetch, decrypt and verify it, plus display metadata. */
export const attachmentSchema = z.strictObject({
  media: mediaReferenceSchema,
  category: z.enum(MEDIA_CATEGORIES),
  mime: z
    .string()
    .max(127)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
  /** Shown as text and used as the download name after sanitising; never as a path or URL. */
  name: z.string().max(255),
  width: z.number().int().min(1).max(20_000).optional(),
  height: z.number().int().min(1).max(20_000).optional(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3_600_000)
    .optional(),
  thumbnail: z
    .string()
    .max(MAX_THUMBNAIL_CHARS)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  /** Voice notes: up to 64 peak levels (0–255). */
  waveform: z.array(z.number().int().min(0).max(255)).max(64).optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** Group names and descriptions (docs/groups.md §3): end-to-end encrypted, never on the server. */
export const MAX_GROUP_NAME = 80;
export const MAX_GROUP_DESCRIPTION = 500;
export const MAX_POLL_OPTIONS = 12;
export const MAX_MENTIONS = 50;
const userRef = z.uuid();

/** Session descriptions carry every network candidate (no trickle), so they can be several KB. */
export const MAX_SDP_LENGTH = 24_000;
export const CALL_SIGNALS = ['offer', 'answer', 'update', 'update_answer', 'end', 'group'] as const;
export type CallSignalKind = (typeof CALL_SIGNALS)[number];

export const contentSchema = z.object({
  v: z.literal(1),
  /** Equals the transport clientMessageId, so retries and echoes are recognisable. */
  id: messageRef,
  /** Sender's clock, informational only; ordering uses the server sequence number. */
  sentAt: z.number().int().nonnegative(),
  body: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('text'),
      text: z.string().min(1).max(MAX_TEXT_LENGTH),
      replyTo: messageRef.optional(),
      /** Members mentioned with @ (highlighted for them). */
      mentions: z.array(userRef).max(MAX_MENTIONS).optional(),
    }),
    z.object({
      kind: z.literal('media'),
      attachment: attachmentSchema,
      caption: z.string().max(MAX_TEXT_LENGTH).optional(),
      replyTo: messageRef.optional(),
    }),
    z.object({
      kind: z.literal('reaction'),
      target: messageRef,
      emoji: z.string().min(1).max(16).nullable(),
    }),
    z.object({
      kind: z.literal('edit'),
      target: messageRef,
      text: z.string().min(1).max(MAX_TEXT_LENGTH),
    }),
    z.object({ kind: z.literal('delete'), target: messageRef }),
    z.object({ kind: z.literal('read'), upToSeq: z.number().int().positive() }),
    // ---- groups (docs/groups.md) ----
    /**
     * Group name and description. Honoured from admins (or anyone when members may edit info).
     * `snapshot` re-sends the current info after adding people, so they learn the name; it only
     * fills in info a member does not have yet.
     */
    z.object({
      kind: z.literal('group_info'),
      name: z.string().trim().min(1).max(MAX_GROUP_NAME),
      description: z.string().max(MAX_GROUP_DESCRIPTION),
      snapshot: z.boolean().optional(),
    }),
    /**
     * Membership intent: an admin (or a member, when members may add) confirms, end to end, who
     * should be in the group. Devices add people to the encryption group only with an intent, so
     * the server cannot slip anyone in (docs/groups.md §4).
     */
    z.object({
      kind: z.literal('group_members'),
      add: z.array(userRef).max(256),
      remove: z.array(userRef).max(256),
    }),
    z.object({ kind: z.literal('pin'), target: messageRef, pinned: z.boolean() }),
    z.object({
      kind: z.literal('poll'),
      question: z.string().trim().min(1).max(300),
      options: z.array(z.string().trim().min(1).max(100)).min(2).max(MAX_POLL_OPTIONS),
      multiple: z.boolean(),
    }),
    /** Latest vote per member counts; an empty list retracts it. */
    z.object({
      kind: z.literal('vote'),
      target: messageRef,
      choices: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(MAX_POLL_OPTIONS - 1),
        )
        .max(MAX_POLL_OPTIONS),
    }),
    /**
     * Call signalling (docs/calling.md §2, ADR-016). Offers and answers travel only inside
     * end-to-end encrypted messages, so their DTLS fingerprints are authenticated by MLS and a
     * malicious server cannot substitute its own. `update`/`update_answer` renegotiate (ICE
     * restart); `group` announces a group call (media goes through the SFU, ADR-047).
     */
    z.object({
      kind: z.literal('call'),
      callId: z.uuid(),
      signal: z.enum(CALL_SIGNALS),
      media: z.enum(['audio', 'video']),
      sdp: z.string().min(1).max(MAX_SDP_LENGTH).optional(),
      /** The one device an answer or renegotiation is meant for. */
      toDevice: z.uuid().optional(),
      reason: z.enum(['hangup', 'declined', 'busy', 'failed', 'missed']).optional(),
    }),
  ]),
});
export type MessageContent = z.infer<typeof contentSchema>;
export type MessageBody = MessageContent['body'];
