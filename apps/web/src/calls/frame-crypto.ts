import {
  AES_128_GCM_SHA256_128,
  EPOCH_BITS,
  decodeHeader,
  deriveFrameKey,
  keyId,
  open,
  seal,
  senderBaseKey,
  splitKeyId,
  type CipherSuite,
  type FrameKey,
} from './sframe.js';

/**
 * End-to-end encryption of group-call media frames (ADR-047): SFrame (RFC 9605) with per-sender
 * keys from the conversation's MLS exporter (RFC 9605 §5.2). Runs in the media worker, one
 * instance for all of this device's tracks, so the sender counter never repeats under a key.
 *
 * The SFU needs to tell VP8 key frames from delta frames to forward and switch layers, so the
 * VP8 payload header (10 bytes on key frames, 3 on delta frames: frame type, dimensions) stays in
 * the clear — as in other SFU end-to-end encryption designs. It is authenticated as SFrame
 * metadata, so it cannot be altered without detection. Everything else, and all audio, is
 * encrypted.
 */

export const CALL_SUITE: CipherSuite = AES_128_GCM_SHA256_128;
/** Receivers keep keys for this many recent epochs, so frames sent around a re-key still play. */
const KEEP_EPOCHS = 3;

export interface EpochKeys {
  readonly epoch: number;
  /** `MLS-Exporter("SFrame 1.0 Base Key", callId, Nk)` for this epoch. */
  readonly secret: Uint8Array;
  readonly ownIndex: number;
}

export type FrameKind = 'audio' | 'video';

/** Bytes left unencrypted at the start of a frame (see above). */
export function clearPrefixLength(kind: FrameKind, keyFrame: boolean): number {
  if (kind === 'audio') return 0;
  return keyFrame ? 10 : 3;
}

export interface Decrypted {
  readonly data: Uint8Array;
  readonly senderIndex: number;
  readonly epoch: number;
}

export class CallFrameCrypto {
  readonly #suite: CipherSuite;
  /** Most recent first. */
  #epochs: EpochKeys[] = [];
  readonly #keys = new Map<string, Promise<FrameKey>>();
  #counter = 0n;
  #sendKey: { epoch: number; key: Promise<FrameKey> } | null = null;

  constructor(suite: CipherSuite = CALL_SUITE) {
    this.#suite = suite;
  }

  get currentEpoch(): number | null {
    return this.#epochs[0]?.epoch ?? null;
  }

  /** A new epoch's keys: used for sending from now on, and kept for receiving. */
  setEpoch(keys: EpochKeys): void {
    if (keys.secret.length !== this.#suite.nk) throw new RangeError('Wrong call key length');
    if (this.#epochs.some((e) => e.epoch === keys.epoch)) return;
    this.#epochs = [keys, ...this.#epochs].sort((a, b) => b.epoch - a.epoch).slice(0, KEEP_EPOCHS);
    const kept = new Set(this.#epochs.map((e) => e.epoch));
    for (const id of this.#keys.keys()) {
      if (!kept.has(Number(id.split(':')[0]))) this.#keys.delete(id);
    }
    const current = this.#epochs[0];
    if (current !== undefined && this.#sendKey?.epoch !== current.epoch) {
      // A new key starts a new counter: (key, counter) pairs never repeat.
      this.#sendKey = { epoch: current.epoch, key: this.#key(current, current.ownIndex) };
      this.#counter = 0n;
    }
  }

  #key(epoch: EpochKeys, senderIndex: number): Promise<FrameKey> {
    const id = `${epoch.epoch}:${senderIndex}`;
    let key = this.#keys.get(id);
    if (key === undefined) {
      key = senderBaseKey(this.#suite, epoch.secret, senderIndex).then((base) =>
        deriveFrameKey(this.#suite, keyId(senderIndex, epoch.epoch), base),
      );
      this.#keys.set(id, key);
    }
    return key;
  }

  /** `clear prefix || SFrame(header || ciphertext)`; null when there is no key yet. */
  async encrypt(frame: Uint8Array, clearPrefix: number): Promise<Uint8Array | null> {
    if (this.#sendKey === null || frame.length < clearPrefix) return null;
    const ctr = this.#counter;
    this.#counter += 1n;
    const key = await this.#sendKey.key;
    const metadata = frame.subarray(0, clearPrefix);
    const sealed = await seal(key, ctr, metadata, frame.subarray(clearPrefix));
    const out = new Uint8Array(clearPrefix + sealed.length);
    out.set(metadata, 0);
    out.set(sealed, clearPrefix);
    return out;
  }

  /** Plaintext frame and who sent it; null for anything that does not authenticate. */
  async decrypt(frame: Uint8Array, clearPrefix: number): Promise<Decrypted | null> {
    if (frame.length <= clearPrefix) return null;
    const metadata = frame.subarray(0, clearPrefix);
    const body = frame.subarray(clearPrefix);
    const header = decodeHeader(body);
    if (header === null) return null;
    const { senderIndex, epochBits } = splitKeyId(header.kid);
    const epoch = this.#epochs.find((e) => e.epoch % (1 << EPOCH_BITS) === epochBits);
    if (epoch === undefined || senderIndex > 0xffff_ffff) return null;
    try {
      const key = await this.#key(epoch, senderIndex);
      const plaintext = await open(key, header, metadata, body);
      const out = new Uint8Array(clearPrefix + plaintext.length);
      out.set(metadata, 0);
      out.set(plaintext, clearPrefix);
      return { data: out, senderIndex, epoch: epoch.epoch };
    } catch {
      return null;
    }
  }
}
