import { z } from 'zod';

import { idSchema } from './common.js';
import { base64Bytes } from './messaging.js';

/**
 * Key directory contracts (docs/crypto-design.md §3–4, ADR-007). The server stores public
 * material only: Account Signing Keys, device certificates and MLS KeyPackages.
 */

/** Upper bounds (bytes). A KeyPackage for the baseline suite is ~300 bytes. */
export const MAX_KEY_PACKAGE_BYTES = 4096;
export const MAX_CERTIFICATE_BYTES = 256;
export const KEY_PACKAGE_BATCH = 100;
/** Clients top up when fewer than this many one-time KeyPackages remain. */
export const KEY_PACKAGE_LOW_WATERMARK = 25;

const keyPackage = base64Bytes(MAX_KEY_PACKAGE_BYTES);

export const registerDeviceSchema = z.strictObject({
  /** Ed25519 Account Signing Key (public), 32 bytes. */
  askPublicKey: base64Bytes(32, 32),
  askVersion: z.number().int().min(1),
  deviceId: idSchema,
  /** DeviceCertificate signed by the ASK (crypto-design §3.2). */
  certificate: base64Bytes(MAX_CERTIFICATE_BYTES),
  keyPackages: z.array(keyPackage).min(1).max(KEY_PACKAGE_BATCH),
  lastResortKeyPackage: keyPackage,
});
export type RegisterDevice = z.infer<typeof registerDeviceSchema>;

export const deviceSchema = z.object({
  deviceId: z.string(),
  certificate: z.string(),
  createdAt: z.iso.datetime(),
});

export const userKeysSchema = z.object({
  userId: z.string(),
  askPublicKey: z.string(),
  askVersion: z.number().int().min(1),
  devices: z.array(deviceSchema),
});
export type UserKeys = z.infer<typeof userKeysSchema>;

export const ownKeysSchema = z.object({
  /** null until the first device is set up. */
  askVersion: z.number().int().min(1).nullable(),
  askPublicKey: z.string().nullable(),
  devices: z.array(deviceSchema),
});

export const uploadKeyPackagesSchema = z.strictObject({
  keyPackages: z.array(keyPackage).max(KEY_PACKAGE_BATCH),
  lastResortKeyPackage: keyPackage.optional(),
});

export const keyPackageCountSchema = z.object({
  oneTime: z.number().int().nonnegative(),
  lastResort: z.boolean(),
});

export const deviceParamsSchema = z.strictObject({ deviceId: idSchema });
export const userParamsSchema = z.strictObject({ userId: idSchema });

export const claimKeyPackagesSchema = z.strictObject({ userId: idSchema });
export const claimedKeyPackagesSchema = z.object({
  keyPackages: z.array(z.object({ deviceId: z.string(), keyPackage: z.string() })),
});
