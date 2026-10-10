import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { REPORT_HPKE_INFO } from '@tessera/validation';

/**
 * The moderation key (docs/moderation.md §3, §8): reporters' devices encrypt report bundles to its
 * public key with HPKE (RFC 9180, base mode, DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 /
 * AES-128-GCM) using the `@hpke/core` library. Evidence stays encrypted at rest; the private key
 * opens it at ingestion (verification, hash matching) and when a moderator views it.
 */

export const reportSuite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

const encoder = new TextEncoder();

/** Additional data binding a bundle to its conversation and reporter. */
export function bundleAad(conversationId: string, reporterId: string): Uint8Array {
  return encoder.encode(`${REPORT_HPKE_INFO}|${conversationId}|${reporterId}`);
}

export class ModerationKey {
  readonly #privateKey: CryptoKey;
  readonly publicKey: string;

  private constructor(privateKey: CryptoKey, publicKey: string) {
    this.#privateKey = privateKey;
    this.publicKey = publicKey;
  }

  static async load(publicKeyB64: string, privateKeyB64: string): Promise<ModerationKey> {
    const privateKey = await reportSuite.kem.deserializePrivateKey(
      Buffer.from(privateKeyB64, 'base64url'),
    );
    return new ModerationKey(privateKey, publicKeyB64);
  }

  /** Opens a bundle; throws if it was not encrypted to this key with this binding. */
  async open(enc: Buffer, ciphertext: Buffer, aad: Uint8Array): Promise<Buffer> {
    const plaintext = await reportSuite.open(
      {
        recipientKey: this.#privateKey,
        enc: new Uint8Array(enc),
        info: encoder.encode(REPORT_HPKE_INFO),
      },
      new Uint8Array(ciphertext),
      aad,
    );
    return Buffer.from(plaintext);
  }
}

/** A fresh key pair (tests and local setup; production keys come from the secrets manager). */
export async function generateModerationKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = await reportSuite.kem.generateKeyPair();
  return {
    publicKey: Buffer.from(await reportSuite.kem.serializePublicKey(pair.publicKey)).toString(
      'base64url',
    ),
    privateKey: Buffer.from(await reportSuite.kem.serializePrivateKey(pair.privateKey)).toString(
      'base64url',
    ),
  };
}

/** Seals like a reporter's device does (tests). */
export async function sealBundle(
  publicKeyB64: string,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<{ enc: string; ciphertext: string }> {
  const recipientPublicKey = await reportSuite.kem.deserializePublicKey(
    Buffer.from(publicKeyB64, 'base64url'),
  );
  const sealed = await reportSuite.seal(
    { recipientPublicKey, info: encoder.encode(REPORT_HPKE_INFO) },
    plaintext,
    aad,
  );
  return {
    enc: Buffer.from(sealed.enc).toString('base64url'),
    ciphertext: Buffer.from(sealed.ct).toString('base64'),
  };
}
