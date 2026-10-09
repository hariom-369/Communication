/**
 * SFrame (RFC 9605) for end-to-end encrypted group-call media (ADR-047, docs/calling.md §3).
 *
 * Nothing here is new cryptography: the AEAD is the browser's AES-GCM (WebCrypto), key
 * derivation is HKDF exactly as RFC 9605 §4.4.2 specifies, and per-sender keys come from the MLS
 * exporter as in RFC 9605 §5.2. The code is checked against the RFC's test vectors
 * (sframe.test.ts). Only the AES-GCM cipher suites are implemented.
 */

export interface CipherSuite {
  readonly id: number;
  readonly hash: 'SHA-256' | 'SHA-512';
  /** Key, nonce and tag lengths in bytes. */
  readonly nk: number;
  readonly nn: number;
  readonly nt: number;
}

/** AES_128_GCM_SHA256_128 — used for calls. */
export const AES_128_GCM_SHA256_128: CipherSuite = {
  id: 0x0004,
  hash: 'SHA-256',
  nk: 16,
  nn: 12,
  nt: 16,
};
export const AES_256_GCM_SHA512_128: CipherSuite = {
  id: 0x0005,
  hash: 'SHA-512',
  nk: 32,
  nn: 12,
  nt: 16,
};

const MAX_U64 = (1n << 64n) - 1n;

/** Big-endian bytes of `value` in exactly `length` bytes. */
function bigEndian(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Fewest bytes (at least one) that hold `value`. */
function minimalLength(value: bigint): number {
  let length = 1;
  while (value >> BigInt(8 * length) !== 0n) length += 1;
  return length;
}

function readBigEndian(bytes: Uint8Array, start: number, length: number): bigint {
  let value = 0n;
  for (let i = 0; i < length; i += 1) value = (value << 8n) | BigInt(bytes[start + i] ?? 0);
  return value;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** WebCrypto wants ArrayBuffer-backed views. */
const buffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

// ---- header (RFC 9605 §4.3) ----------------------------------------------------------------------

/**
 * `X|K|Y|C` config byte, then the key ID and counter in their shortest big-endian forms. Values
 * up to 7 fit in the config byte itself.
 */
export function encodeHeader(kid: bigint, ctr: bigint): Uint8Array {
  if (kid < 0n || kid > MAX_U64 || ctr < 0n || ctr > MAX_U64)
    throw new RangeError('SFrame key ID and counter are 64-bit unsigned');
  let config = 0;
  const parts: Uint8Array[] = [];
  if (kid < 8n) config |= Number(kid) << 4;
  else {
    const length = minimalLength(kid);
    config |= 0x80 | ((length - 1) << 4);
    parts.push(bigEndian(kid, length));
  }
  if (ctr < 8n) config |= Number(ctr);
  else {
    const length = minimalLength(ctr);
    config |= 0x08 | (length - 1);
    parts.push(bigEndian(ctr, length));
  }
  return concat(Uint8Array.of(config), ...parts);
}

export interface Header {
  readonly kid: bigint;
  readonly ctr: bigint;
  /** Encoded length in bytes. */
  readonly length: number;
}

/** Parses a header at the start of `bytes`; null if it is truncated. */
export function decodeHeader(bytes: Uint8Array): Header | null {
  const config = bytes[0];
  if (config === undefined) return null;
  let offset = 1;
  let kid: bigint;
  if ((config & 0x80) === 0) kid = BigInt((config >> 4) & 0x07);
  else {
    const length = ((config >> 4) & 0x07) + 1;
    if (bytes.length < offset + length) return null;
    kid = readBigEndian(bytes, offset, length);
    offset += length;
  }
  let ctr: bigint;
  if ((config & 0x08) === 0) ctr = BigInt(config & 0x07);
  else {
    const length = (config & 0x07) + 1;
    if (bytes.length < offset + length) return null;
    ctr = readBigEndian(bytes, offset, length);
    offset += length;
  }
  return { kid, ctr, length: offset };
}

// ---- keys (RFC 9605 §4.4.2) ----------------------------------------------------------------------

const encoder = new TextEncoder();

export interface FrameKey {
  readonly suite: CipherSuite;
  readonly kid: bigint;
  readonly key: CryptoKey;
  readonly salt: Uint8Array;
}

function label(kind: 'key' | 'salt', kid: bigint, suite: CipherSuite): Uint8Array {
  return concat(
    encoder.encode(`SFrame 1.0 Secret ${kind} `),
    bigEndian(kid, 8),
    bigEndian(BigInt(suite.id), 2),
  );
}

/**
 * `sframe_key` and `sframe_salt` for a key ID. HKDF-Extract with an empty salt followed by
 * HKDF-Expand is exactly WebCrypto's HKDF with an empty salt.
 */
export async function deriveFrameKey(
  suite: CipherSuite,
  kid: bigint,
  baseKey: Uint8Array,
): Promise<FrameKey & { readonly rawKey: Uint8Array }> {
  const ikm = await crypto.subtle.importKey('raw', buffer(baseKey), 'HKDF', false, ['deriveBits']);
  const expand = async (info: Uint8Array, length: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: suite.hash, salt: new Uint8Array(0), info: buffer(info) },
        ikm,
        length * 8,
      ),
    );
  const rawKey = await expand(label('key', kid, suite), suite.nk);
  const salt = await expand(label('salt', kid, suite), suite.nn);
  const key = await crypto.subtle.importKey('raw', buffer(rawKey), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { suite, kid, key, salt, rawKey };
}

/** `sframe_salt XOR CTR`, the counter big-endian in Nn bytes (RFC 9605 §4.4.3). */
export function frameNonce(salt: Uint8Array, ctr: bigint): Uint8Array {
  const counter = bigEndian(ctr, salt.length);
  return salt.map((byte, i) => byte ^ (counter[i] ?? 0));
}

// ---- encryption (RFC 9605 §4.4.3 and §4.4.4) ----------------------------------------------------

/** `header || AEAD(plaintext)`, authenticating `header || metadata`. */
export async function seal(
  key: FrameKey,
  ctr: bigint,
  metadata: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const header = encodeHeader(key.kid, ctr);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: buffer(frameNonce(key.salt, ctr)),
      additionalData: buffer(concat(header, metadata)),
      tagLength: key.suite.nt * 8,
    },
    key.key,
    buffer(plaintext),
  );
  return concat(header, new Uint8Array(ciphertext));
}

/** Decrypts a frame produced by `seal` under `key` (whose ID the caller read from the header). */
export async function open(
  key: FrameKey,
  header: Header,
  metadata: Uint8Array,
  frame: Uint8Array,
): Promise<Uint8Array> {
  const headerBytes = frame.subarray(0, header.length);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: buffer(frameNonce(key.salt, header.ctr)),
      additionalData: buffer(concat(headerBytes, metadata)),
      tagLength: key.suite.nt * 8,
    },
    key.key,
    buffer(frame.subarray(header.length)),
  );
  return new Uint8Array(plaintext);
}

// ---- MLS-based keys (RFC 9605 §5.2) ------------------------------------------------------------

/** Low key-ID bits that carry the MLS epoch, so receivers can tell keys of adjacent epochs apart. */
export const EPOCH_BITS = 4;

export function keyId(senderIndex: number, epoch: number): bigint {
  return (BigInt(senderIndex) << BigInt(EPOCH_BITS)) + BigInt(epoch % (1 << EPOCH_BITS));
}

export function splitKeyId(kid: bigint): { senderIndex: number; epochBits: number } {
  return {
    senderIndex: Number(kid >> BigInt(EPOCH_BITS)),
    epochBits: Number(kid & BigInt((1 << EPOCH_BITS) - 1)),
  };
}

/** HKDF-Expand (RFC 5869) for outputs no longer than one hash block. */
export async function hkdfExpandBlock(
  hash: CipherSuite['hash'],
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buffer(prk), { name: 'HMAC', hash }, false, [
    'sign',
  ]);
  const block = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, buffer(concat(info, Uint8Array.of(1)))),
  );
  if (length > block.length) throw new RangeError('HKDF output longer than one block');
  return block.slice(0, length);
}

/** `base_key = HKDF-Expand(sframe_epoch_secret, encode_big_endian(index, 4), Nk)`. */
export function senderBaseKey(
  suite: CipherSuite,
  epochSecret: Uint8Array,
  senderIndex: number,
): Promise<Uint8Array> {
  return hkdfExpandBlock(suite.hash, epochSecret, bigEndian(BigInt(senderIndex), 4), suite.nk);
}
