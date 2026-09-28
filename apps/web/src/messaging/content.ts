import { z } from 'zod';

/**
 * Plaintext message content — what lives *inside* the ciphertext. The server never sees it.
 * Control messages (reactions, edits, deletions, read markers) are ordinary messages in the
 * conversation, so they are protected and ordered exactly like text (docs/messaging.md §6).
 *
 * Phase 4 moves this model into the Protobuf envelope carried by MLS (docs/crypto-design.md §9).
 */
export const MAX_TEXT_LENGTH = 16_000;

const messageRef = z.string().min(1).max(64);

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

/** Turns content into transport bytes and back. Implementations must never throw on decode. */
export interface MessageCodec {
  /** Stable identifier (used in diagnostics and the production bundle check). */
  readonly name: string;
  readonly ciphersuite: number;
  /** True when content is NOT end-to-end encrypted (development codec). */
  readonly unprotected: boolean;
  encode(content: MessageContent): Promise<string>;
  decode(ciphertext: string): Promise<MessageContent | null>;
}
