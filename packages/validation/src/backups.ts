import { z } from 'zod';

import { idSchema } from './common.js';
import { base64Bytes } from './messaging.js';

/**
 * Encrypted backup contracts (docs/encrypted-backups.md). The server stores ciphertext, an
 * authenticated manifest and wrapped keys; it never receives a key that opens a backup.
 */

/** Largest encrypted backup accepted (Phase 5 stores backups in PostgreSQL; ADR-042). */
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
/** Backup versions kept per account. */
export const BACKUP_VERSIONS_KEPT = 3;

const wrapSchema = base64Bytes(72, 72);

export const addBackupWrapSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('recovery'), wrap: wrapSchema }),
  z.strictObject({
    kind: z.literal('passkey'),
    wrap: wrapSchema,
    /** WebAuthn credential id (base64url) whose PRF output wraps the key. */
    credentialId: z.string().min(1).max(1024),
    prfSalt: base64Bytes(32, 32),
  }),
]);

export type AddBackupWrap = z.infer<typeof addBackupWrapSchema>;

export const backupWrapSchema = z.object({
  id: z.string(),
  kind: z.enum(['recovery', 'passkey']),
  credentialId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const backupStatusSchema = z.object({
  latest: z
    .object({
      version: z.number().int(),
      createdAt: z.iso.datetime(),
      size: z.number().int(),
      /** Authenticated manifest, so a device can tell whether its backup key made it. */
      manifest: z.string(),
      mac: z.string(),
    })
    .nullable(),
  wraps: z.array(backupWrapSchema),
});

export const uploadBackupSchema = z.strictObject({
  version: z.number().int().min(1),
  manifest: z.string().min(2).max(2048),
  mac: base64Bytes(32, 32),
  blob: base64Bytes(MAX_BACKUP_BYTES),
});

export type UploadBackup = z.infer<typeof uploadBackupSchema>;

/** Everything a new device needs to restore (still encrypted). */
export const backupDownloadSchema = z.object({
  version: z.number().int(),
  manifest: z.string(),
  mac: z.string(),
  blob: z.string(),
  createdAt: z.iso.datetime(),
  wraps: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['recovery', 'passkey']),
      wrap: z.string(),
      credentialId: z.string().nullable(),
      prfSalt: z.string().nullable(),
    }),
  ),
});

export const backupWrapParamsSchema = z.strictObject({ id: idSchema });
