import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Messaging wire contracts (docs/messaging.md). The server only ever sees `ciphertext`: opaque
 * bytes (base64) produced by the client. It never parses message content.
 */

/**
 * MLS ciphersuite of a conversation (RFC 9420 registry value). Phase 4 supports only the
 * mandatory baseline suite 0x0001, MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
 * (docs/crypto-design.md §2); the hybrid post-quantum suite waits on review S-02.
 */
export const MLS_CIPHERSUITE = 0x0001;
export const SUPPORTED_CIPHERSUITES: readonly number[] = [MLS_CIPHERSUITE];
export const ciphersuiteSchema = z.number().int().min(1).max(0xffff);

/** Maximum ciphertext size per message (docs/messaging.md §8). Media travels as blobs. */
export const MAX_CIPHERTEXT_BYTES = 64 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64 bytes with a decoded-size bound. */
export function base64Bytes(maxBytes: number, minBytes = 1): z.ZodString {
  return z
    .string()
    .min(Math.ceil(minBytes / 3) * 4)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(BASE64, { message: 'Must be base64' });
}

export const ciphertextSchema = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4)
  .regex(BASE64, { message: 'Must be base64' });

export const disappearingSecondsSchema = z.union([
  z.literal(0),
  z.literal(24 * 3600),
  z.literal(7 * 24 * 3600),
  z.literal(90 * 24 * 3600),
]);

export const conversationMemberSchema = z.object({
  userId: z.string(),
  username: z.string(),
});

export const conversationSchema = z.object({
  id: z.string(),
  kind: z.enum(['direct']),
  ciphersuite: ciphersuiteSchema,
  epoch: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  lastActivityAt: z.iso.datetime(),
  disappearingSeconds: disappearingSecondsSchema,
  members: z.array(conversationMemberSchema),
  /** Highest sequence number acknowledged by the caller (for unread counts). */
  ackedSeq: z.number().int().nonnegative(),
  /** Highest sequence number the *other* members have acknowledged (delivery state). */
  peersAckedSeq: z.number().int().nonnegative(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const createDirectConversationSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(32),
  ciphersuite: ciphersuiteSchema,
});

export const conversationListQuerySchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const conversationListSchema = z.object({
  conversations: z.array(conversationSchema),
  nextCursor: z.string().nullable(),
});

export const sendMessageSchema = z.strictObject({
  /** Client-generated UUIDv7; resending with the same id is idempotent. */
  clientMessageId: idSchema,
  /** The caller's device that encrypted the message (must be one of the caller's active devices). */
  senderDeviceId: idSchema,
  epoch: z.number().int().nonnegative(),
  /** MLS PrivateMessage. */
  ciphertext: ciphertextSchema,
  /**
   * Attachments this message references (docs/media.md §2): uploaded by the sender, linked to
   * this conversation so its members can download them. At most 10.
   */
  attachments: z.array(idSchema).max(10).optional(),
});

/** Largest Welcome accepted (it carries the ratchet tree; bounded by the group-size cap). */
export const MAX_WELCOME_BYTES = 64 * 1024;

/**
 * MLS commit for the delivery service (ADR-009): accepted only if `epoch` equals the
 * conversation's current epoch (compare-and-set), otherwise 409 and the client re-bases.
 */
export const commitSchema = z.strictObject({
  clientMessageId: idSchema,
  senderDeviceId: idSchema,
  epoch: z.number().int().nonnegative(),
  /** MLS PublicMessage containing the Commit. */
  commit: ciphertextSchema,
  /** Welcome for the devices this commit adds, delivered to each of `welcomeTargets`. */
  welcome: base64Bytes(MAX_WELCOME_BYTES).nullable(),
  welcomeTargets: z.array(z.strictObject({ userId: idSchema, deviceId: idSchema })).max(100),
});

export const commitResponseSchema = z.object({
  seq: z.number().int().positive(),
  /** The conversation's epoch after this commit. */
  epoch: z.number().int().positive(),
  serverTime: z.iso.datetime(),
  duplicate: z.boolean(),
});

export const welcomeSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Sequence number of the commit that added this device: history before it is not readable. */
  commitSeq: z.number().int().positive(),
  welcome: z.string(),
});
export type WelcomeMessage = z.infer<typeof welcomeSchema>;

export const welcomeListQuerySchema = z.strictObject({ deviceId: idSchema });
export const welcomeListSchema = z.object({ welcomes: z.array(welcomeSchema) });

export const sendMessageResponseSchema = z.object({
  seq: z.number().int().positive(),
  serverTime: z.iso.datetime(),
  duplicate: z.boolean(),
});

export const mailboxMessageSchema = z.object({
  seq: z.number().int().positive(),
  /** `commit` messages are MLS handshakes every member device must process in order. */
  kind: z.enum(['application', 'commit']),
  clientMessageId: z.string(),
  senderUserId: z.string(),
  senderDeviceId: z.string(),
  epoch: z.number().int().nonnegative(),
  ciphertext: z.string(),
  serverTime: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>;

export const messageListQuerySchema = z.strictObject({
  /** Return messages with seq > after (ascending). */
  after: z.coerce.number().int().nonnegative().optional(),
  /** Return messages with seq < before (descending page, returned ascending). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const messageListSchema = z.object({
  messages: z.array(mailboxMessageSchema),
  /** Oldest sequence number still retained by the server (older history is on devices only). */
  earliestAvailableSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const ackSchema = z.strictObject({ seq: z.number().int().positive() });

export const syncResponseSchema = z.object({
  conversations: z.array(
    z.object({
      id: z.string(),
      ackedSeq: z.number().int().nonnegative(),
      lastSeq: z.number().int().nonnegative(),
    }),
  ),
});

export const setDisappearingSchema = z.strictObject({ seconds: disappearingSecondsSchema });

export const userLookupSchema = z.object({ id: z.string(), username: z.string() });

export const presenceSchema = z.object({
  userId: z.string(),
  /** null when hidden by the user's privacy settings (or yours — reciprocity). */
  online: z.boolean().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});

export const realtimeTicketSchema = z.object({
  ticket: z.string(),
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
