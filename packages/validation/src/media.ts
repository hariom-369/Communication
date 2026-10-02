import { z } from 'zod';

import { idSchema } from './common.js';
import { base64Bytes } from './messaging.js';

/**
 * End-to-end encrypted attachments (docs/media.md). The server sees ciphertext sizes and which
 * conversation an attachment was sent to, never names, types, keys or content.
 */

/** Largest attachment before encryption (docs/media.md §1). */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
/** Media STREAM framing (packages/crypto-core/src/media.rs): header + 16-byte tag per 64 KiB. */
export function mediaCiphertextSize(plaintextBytes: number): number {
  return 23 + plaintextBytes + (Math.floor(plaintextBytes / 65_536) + 1) * 16;
}
export const MAX_MEDIA_CIPHERTEXT_BYTES = mediaCiphertextSize(MAX_MEDIA_BYTES);
/** Multipart part size chosen by the server (S3 minimum is 5 MiB except for the last part). */
export const MEDIA_PART_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export const createUploadSchema = z.strictObject({
  /** Ciphertext size in bytes. */
  size: z.number().int().min(39).max(MAX_MEDIA_CIPHERTEXT_BYTES),
});

const partUrl = z.object({ partNumber: z.number().int(), url: z.string() });

export const uploadCreatedSchema = z.object({
  blobId: z.string(),
  partSize: z.number().int(),
  parts: z.array(partUrl),
  /** When the part URLs stop working (request fresh ones with `media.upload_parts`). */
  urlsExpireAt: z.iso.datetime(),
});

export const uploadPartsSchema = z.strictObject({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(64),
});
export const uploadPartsResponseSchema = z.object({
  parts: z.array(partUrl),
  urlsExpireAt: z.iso.datetime(),
});

export const completeUploadSchema = z.strictObject({
  parts: z
    .array(
      z.strictObject({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(64),
});

export const mediaDownloadSchema = z.object({
  url: z.string(),
  size: z.number().int(),
  urlExpiresAt: z.iso.datetime(),
});

export const blobParamsSchema = z.strictObject({ blobId: idSchema });

/**
 * What a media message carries inside the MLS ciphertext (never visible to the server). Lives
 * here so the web client and tests share one definition.
 */
export const mediaReferenceSchema = z.strictObject({
  blobId: z.string().min(1).max(64),
  key: base64Bytes(32, 32),
  plaintextSha256: base64Bytes(32, 32),
  ciphertextSha256: base64Bytes(32, 32),
  plaintextSize: z.number().int().min(0).max(MAX_MEDIA_BYTES),
  ciphertextSize: z.number().int().min(39).max(MAX_MEDIA_CIPHERTEXT_BYTES),
});
export type MediaReference = z.infer<typeof mediaReferenceSchema>;
