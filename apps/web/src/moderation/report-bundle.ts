import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import {
  MAX_REPORT_BUNDLE_BYTES,
  MAX_REPORT_CONTEXT,
  MAX_REPORT_MEDIA,
  MAX_REPORTED_MESSAGES,
  REPORT_HPKE_INFO,
  reportBundleAad,
  type ReportBundle,
} from '@tessera/validation';

import type { HistoryRecord } from '../crypto/protocol.js';

/**
 * Reporting end-to-end encrypted messages (docs/moderation.md §3). The reporter's device sends
 * exactly what the person chose — the selected messages, optionally a few earlier ones for
 * context, and optionally the decrypted files — encrypted to the moderation key with HPKE
 * (RFC 9180, via @hpke/core). Each message travels as the exact decrypted text with its franking
 * commitment and the server's tag, so the server can verify it was really sent (ADR-021).
 */

export const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

export interface ReportedFile {
  readonly seq: number;
  readonly name: string;
  readonly mime: string;
  readonly data: Uint8Array;
}

export class ReportTooLarge extends Error {
  constructor() {
    super('This report is too large. Leave out some files and try again.');
    this.name = 'ReportTooLarge';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The selected messages and up to `context` earlier ones, as they are stored on this device. */
export function buildBundle(input: {
  conversationId: string;
  reporterId: string;
  history: readonly HistoryRecord[];
  selected: readonly number[];
  context: number;
  files?: readonly ReportedFile[];
}): ReportBundle {
  const readable = input.history.filter((record) => record.content !== null);
  const chosen = new Set(input.selected);
  const selected = readable.filter((record) => chosen.has(record.seq));
  if (selected.length === 0) throw new Error('Choose at least one message to report.');
  if (selected.length > MAX_REPORTED_MESSAGES)
    throw new Error(`You can report up to ${MAX_REPORTED_MESSAGES} messages at once.`);
  const first = Math.min(...selected.map((record) => record.seq));
  const context = readable
    .filter((record) => record.seq < first && !chosen.has(record.seq))
    .slice(-Math.min(Math.max(0, input.context), MAX_REPORT_CONTEXT));
  const messages = [...context, ...selected]
    .sort((a, b) => a.seq - b.seq)
    .map((record) => ({
      seq: record.seq,
      senderUserId: record.senderUserId,
      senderDeviceId: record.senderDeviceId,
      serverTime: record.serverTime,
      clientMessageId: record.clientMessageId,
      selected: chosen.has(record.seq),
      plaintext: record.content ?? '',
      commitment: record.franking?.commitment ?? null,
      frankingTag: record.franking?.tag ?? null,
    }));
  const files = input.files ?? [];
  if (files.length > MAX_REPORT_MEDIA)
    throw new Error(`You can include up to ${MAX_REPORT_MEDIA} files.`);
  return {
    v: 1,
    conversationId: input.conversationId,
    reporterId: input.reporterId,
    messages,
    media: files.map((file) => ({
      seq: file.seq,
      name: file.name.slice(0, 255),
      mime: file.mime.slice(0, 127),
      data: toBase64(file.data),
    })),
  };
}

/** Seals a bundle to the moderation key, bound to its conversation and reporter. */
export async function sealBundle(
  publicKey: string,
  bundle: ReportBundle,
): Promise<{ enc: string; ciphertext: string }> {
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  // AES-GCM adds a 16-byte tag; the server accepts up to MAX_REPORT_BUNDLE_BYTES of ciphertext.
  if (plaintext.length + 16 > MAX_REPORT_BUNDLE_BYTES) throw new ReportTooLarge();
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64Url(publicKey));
  const encoder = new TextEncoder();
  const sealed = await suite.seal(
    { recipientPublicKey, info: encoder.encode(REPORT_HPKE_INFO) },
    plaintext,
    encoder.encode(reportBundleAad(bundle.conversationId, bundle.reporterId)),
  );
  return {
    enc: toBase64Url(new Uint8Array(sealed.enc)),
    ciphertext: toBase64(new Uint8Array(sealed.ct)),
  };
}
