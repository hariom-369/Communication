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

/** Devices per account (docs/multi-device.md §1). */
export const MAX_DEVICES = 8;

export const deviceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} .,()'_/+-]+$/u, { message: 'Use letters, numbers and simple punctuation' });

export const registerDeviceSchema = z.strictObject({
  /** Ed25519 Account Signing Key (public), 32 bytes. */
  askPublicKey: base64Bytes(32, 32),
  askVersion: z.number().int().min(1),
  deviceId: idSchema,
  /** DeviceCertificate signed by the ASK (crypto-design §3.2). */
  certificate: base64Bytes(MAX_CERTIFICATE_BYTES),
  keyPackages: z.array(keyPackage).min(1).max(KEY_PACKAGE_BATCH),
  lastResortKeyPackage: keyPackage,
  label: deviceLabelSchema.optional(),
});
export type RegisterDevice = z.infer<typeof registerDeviceSchema>;

export const deviceSchema = z.object({
  deviceId: z.string(),
  certificate: z.string(),
  createdAt: z.iso.datetime(),
});

/** A device as the account owner sees it in the device list. */
export const ownDeviceSchema = deviceSchema.extend({
  label: z.string(),
  trusted: z.boolean(),
  lastSeenAt: z.iso.datetime(),
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
  devices: z.array(ownDeviceSchema),
});

/** A device that joins an existing identity (linked or restored from a backup). */
export const addDeviceSchema = z.strictObject({
  deviceId: idSchema,
  askVersion: z.number().int().min(1),
  /** Certificate signed by the account's *current* identity key. */
  certificate: base64Bytes(MAX_CERTIFICATE_BYTES),
  keyPackages: z.array(keyPackage).min(1).max(KEY_PACKAGE_BATCH),
  lastResortKeyPackage: keyPackage,
  label: deviceLabelSchema,
  trusted: z.boolean(),
});
export type AddDevice = z.infer<typeof addDeviceSchema>;

// ---- device linking (docs/multi-device.md §3) ----------------------------------------------

export const createLinkSchema = z.strictObject({
  deviceId: idSchema,
  hpkePublic: base64Bytes(32, 32),
  signaturePublic: base64Bytes(32, 32),
  label: deviceLabelSchema,
});
export type CreateLink = z.infer<typeof createLinkSchema>;

export const linkCreatedSchema = z.object({
  linkId: z.string(),
  /** 5 bytes, base64: the first part of the link code. */
  shortId: z.string(),
  expiresAt: z.iso.datetime(),
});

export const linkLookupParamsSchema = z.strictObject({
  shortId: z.string().regex(/^[A-Za-z0-9_-]{7}$/, { message: 'Invalid link id' }),
});
export const linkParamsSchema = z.strictObject({ linkId: idSchema });

/** What an existing device sees before approving. */
export const linkRequestSchema = z.object({
  linkId: z.string(),
  deviceId: z.string(),
  hpkePublic: z.string(),
  signaturePublic: z.string(),
  label: z.string(),
  createdAt: z.iso.datetime(),
});

export const approveLinkSchema = z.strictObject({
  approverDeviceId: idSchema,
  /** HPKE-sealed payload (may include transferred history). */
  sealed: base64Bytes(8 * 1024 * 1024),
});

export const linkStatusSchema = z.object({
  status: z.enum(['pending', 'approved']),
  sealed: z.string().nullable(),
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
