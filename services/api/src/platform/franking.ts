import { constantTimeEqual, hmacSha256, type Keyring } from './secrets.js';

/**
 * Server side of message franking (ADR-021, docs/moderation.md §3; S-10 review pending).
 *
 * The published construction used by Facebook Messenger's encrypted conversations (analysed by
 * Grubbs, Lu and Ristenpart, CRYPTO 2017): the sender commits to the exact plaintext with
 * `commitment = HMAC-SHA256(franking key, plaintext)`, carrying the fresh franking key inside
 * the encrypted message; the server, which never sees the plaintext, binds the commitment to
 * what it does know with its own MAC — the tag. A recipient who reports the message reveals the
 * plaintext (with the franking key); the server checks the tag (this sender's device sent this
 * commitment in this conversation at this time) and the commitment (it opens to this
 * plaintext). Nothing is stored for this: the tag travels with the message.
 */

const CONTEXT = 'tessera-franking-tag-v1';

export interface FrankedMessage {
  readonly conversationId: string;
  readonly seq: number;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly clientMessageId: string;
  /** ISO 8601, as delivered. */
  readonly serverTime: string;
}

function input(commitment: Buffer, message: FrankedMessage): Buffer {
  // Length-prefixed fields: no field boundary can be shifted into another.
  const parts = [
    CONTEXT,
    message.conversationId,
    String(message.seq),
    message.senderUserId,
    message.senderDeviceId,
    message.clientMessageId,
    message.serverTime,
  ].map((part): Buffer => Buffer.from(part, 'utf8'));
  parts.push(Buffer.from(commitment));
  return Buffer.concat(
    parts.flatMap((part) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(part.length);
      return [length, part];
    }),
  );
}

export class FrankingTagger {
  readonly #keyring: Keyring;

  constructor(keyring: Keyring) {
    this.#keyring = keyring;
  }

  /** `<key id>.<base64url tag>` */
  tag(commitment: Buffer, message: FrankedMessage): string {
    const { id, key } = this.#keyring.current;
    return `${id}.${hmacSha256(key, input(commitment, message)).toString('base64url')}`;
  }

  verify(tag: string, commitment: Buffer, message: FrankedMessage): boolean {
    const dot = tag.indexOf('.');
    if (dot <= 0) return false;
    const key = this.#keyring.keys.get(tag.slice(0, dot));
    if (key === undefined) return false;
    const expected = hmacSha256(key, input(commitment, message));
    return constantTimeEqual(expected, Buffer.from(tag.slice(dot + 1), 'base64url'));
  }
}

/** The sender's commitment check: HMAC-SHA256(frankingKey, plaintext) == commitment. */
export function commitmentOpens(
  commitment: Buffer,
  frankingKey: Buffer,
  plaintext: Buffer,
): boolean {
  if (frankingKey.length !== 32 || commitment.length !== 32) return false;
  return constantTimeEqual(hmacSha256(frankingKey, plaintext), commitment);
}
