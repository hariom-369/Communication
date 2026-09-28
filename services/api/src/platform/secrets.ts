import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Small wrappers over node:crypto primitives used for tokens and server-side secrets. No custom
 * cryptography: SHA-256, HMAC-SHA-256 and AES-256-GCM with random 96-bit nonces, as specified.
 */

/** URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hmacSha256(key: Buffer, value: string | Buffer): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Uniformly random decimal code of `digits` digits (rejection sampling, no modulo bias). */
export function randomDigits(digits: number): string {
  const limit = 10 ** digits;
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
  for (;;) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < ceiling) return String(value % limit).padStart(digits, '0');
  }
}

export interface Keyring {
  /** Key used for new encryptions. */
  readonly current: { readonly id: string; readonly key: Buffer };
  /** All keys that may decrypt existing data, by id. */
  readonly keys: ReadonlyMap<string, Buffer>;
}

/** Parses `id:base64key,id2:base64key` (first entry is current). Keys must be 32 bytes. */
export function parseKeyring(spec: string): Keyring {
  const entries = spec.split(',').map((part) => {
    const [id, encoded, ...rest] = part.trim().split(':');
    if (
      id === undefined ||
      encoded === undefined ||
      rest.length > 0 ||
      !/^[a-z0-9]{1,16}$/.test(id)
    ) {
      throw new Error('Keyring entries must look like "<id>:<base64 key>"');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error(`Key ${id} must be 32 bytes`);
    return [id, key] as const;
  });
  const first = entries[0];
  if (first === undefined) throw new Error('Keyring is empty');
  const keys = new Map(entries);
  if (keys.size !== entries.length) throw new Error('Keyring contains duplicate ids');
  return { current: { id: first[0], key: first[1] }, keys };
}

/**
 * Authenticated encryption for server-held secrets (e.g. TOTP seeds). Envelope:
 * `v1.<keyId>.<nonce b64url>.<ciphertext+tag b64url>`; `aad` binds the ciphertext to its row so
 * values cannot be swapped between users. Production keys come from the secret manager (KMS
 * envelope encryption is the planned upgrade, docs/security.md §9).
 */
export class SecretBox {
  readonly #keyring: Keyring;

  constructor(keyring: Keyring) {
    this.#keyring = keyring;
  }

  seal(plaintext: Buffer, aad: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#keyring.current.key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return [
      'v1',
      this.#keyring.current.id,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(envelope: string, aad: string): Buffer {
    const [version, keyId, nonceText, bodyText] = envelope.split('.');
    if (
      version !== 'v1' ||
      keyId === undefined ||
      nonceText === undefined ||
      bodyText === undefined
    ) {
      throw new Error('Malformed secret envelope');
    }
    const key = this.#keyring.keys.get(keyId);
    if (key === undefined) throw new Error('Unknown secret key id');
    const body = Buffer.from(bodyText, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceText, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  }

  /** True when the envelope was sealed with a key other than the current one (re-seal on use). */
  needsRotation(envelope: string): boolean {
    return envelope.split('.')[1] !== this.#keyring.current.id;
  }
}
