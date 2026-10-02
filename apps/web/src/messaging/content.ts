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
  ]),
});
export type MessageContent = z.infer<typeof contentSchema>;
export type MessageBody = MessageContent['body'];
