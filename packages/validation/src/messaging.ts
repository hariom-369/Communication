import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Messaging wire contracts (docs/messaging.md). The server only ever sees `ciphertext`: opaque
 * bytes (base64) produced by the client. It never parses message content.
 */

/**
 * Ciphersuite of a conversation. `0` = no protection, **development only**: the API refuses it
 * unless MESSAGING_DEV_PLAINTEXT is enabled, which production configuration forbids. Real suites
 * (MLS, ADR-004/005) are introduced in Phase 4.
 */
export const DEV_PLAINTEXT_CIPHERSUITE = 0;
export const ciphersuiteSchema = z.number().int().min(0).max(0xffff);

/** Maximum ciphertext size per message (docs/messaging.md §8). Media travels as blobs. */
export const MAX_CIPHERTEXT_BYTES = 64 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
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
  epoch: z.number().int().nonnegative(),
  ciphertext: ciphertextSchema,
});

export const sendMessageResponseSchema = z.object({
  seq: z.number().int().positive(),
  serverTime: z.iso.datetime(),
  duplicate: z.boolean(),
});

export const mailboxMessageSchema = z.object({
  seq: z.number().int().positive(),
  clientMessageId: z.string(),
  senderUserId: z.string(),
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
