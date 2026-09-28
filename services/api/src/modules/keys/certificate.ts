import { createPublicKey, verify } from 'node:crypto';

/**
 * Server-side parsing and verification of device certificates (docs/crypto-design.md §3.2).
 *
 * Clients are the authority: every client verifies certificates against the identity it pinned.
 * The server checks them too (defence in depth), so a buggy or malicious client cannot publish a
 * device that could never verify, and so the directory only ever holds well-formed data.
 * Layout mirrors packages/crypto-core/src/identity.rs exactly.
 */

const CONTEXT = Buffer.from('tessera-device-cert-v1', 'utf8');
const VERSION = 1;
const MAX_SUITES = 8;
export const MAX_CERTIFICATE_BYTES = 256;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface DeviceCertificate {
  readonly userId: string;
  readonly deviceId: string;
  readonly mlsSignatureKey: Buffer;
  readonly askVersion: number;
  readonly createdAt: number;
  readonly ciphersuites: readonly number[];
  readonly body: Buffer;
  readonly signature: Buffer;
}

function uuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Strict parse; returns null for anything malformed. */
export function parseCertificate(bytes: Buffer): DeviceCertificate | null {
  if (bytes.length > MAX_CERTIFICATE_BYTES || bytes.length < 1 + 16 + 16 + 32 + 4 + 8 + 1 + 64)
    return null;
  let offset = 0;
  const take = (count: number): Buffer | null => {
    if (offset + count > bytes.length) return null;
    const slice = bytes.subarray(offset, offset + count);
    offset += count;
    return slice;
  };
  if (take(1)?.[0] !== VERSION) return null;
  const user = take(16);
  const device = take(16);
  const mlsSignatureKey = take(32);
  const askVersion = take(4);
  const createdAt = take(8);
  const count = take(1)?.[0];
  if (
    user === null ||
    device === null ||
    mlsSignatureKey === null ||
    askVersion === null ||
    createdAt === null ||
    count === undefined ||
    count === 0 ||
    count > MAX_SUITES
  )
    return null;
  const ciphersuites: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const suite = take(2);
    if (suite === null) return null;
    ciphersuites.push(suite.readUInt16BE(0));
  }
  const bodyEnd = offset;
  const signature = take(64);
  if (signature === null || offset !== bytes.length) return null;
  return {
    userId: uuid(user),
    deviceId: uuid(device),
    mlsSignatureKey: Buffer.from(mlsSignatureKey),
    askVersion: askVersion.readUInt32BE(0),
    createdAt: Number(createdAt.readBigUInt64BE(0)),
    ciphersuites,
    body: Buffer.from(bytes.subarray(0, bodyEnd)),
    signature: Buffer.from(signature),
  };
}

/** Verifies the certificate signature with the user's Account Signing Key (raw Ed25519, 32 bytes). */
export function verifyCertificate(certificate: DeviceCertificate, askPublicKey: Buffer): boolean {
  if (askPublicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, askPublicKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.concat([CONTEXT, certificate.body]), key, certificate.signature);
  } catch {
    return false;
  }
}
