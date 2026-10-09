import { z } from 'zod';

/**
 * Usernames (docs/authentication.md §1): 5–32 characters, lower-case ASCII letters, digits and
 * underscores, starting with a letter. ASCII-only means no confusable look-alikes; input is
 * normalised (trimmed, lower-cased) before validation.
 */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{4,31}$/;

/** Names that could impersonate the platform or staff. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'abuse',
  'help',
  'helpdesk',
  'moderator',
  'official',
  'postmaster',
  'root',
  'security',
  'support',
  'system',
  'tessera',
  'tessera_app',
  'tessera_help',
  'tessera_official',
  'tessera_support',
  'trust_and_safety',
  'verified',
  'webmaster',
]);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, {
    message: 'Use 5–32 lower-case letters, digits or underscores, starting with a letter',
  })
  .refine((value) => !RESERVED_USERNAMES.has(value), { message: 'This username is reserved' });

export const emailSchema = z.string().trim().max(254).pipe(z.email());

/** Current version of the Terms of Service / Privacy Notice presented at sign-up. */
export const CURRENT_TERMS_VERSION = '2026-09-draft';

export const signupRequestSchema = z.strictObject({
  email: emailSchema,
  username: usernameSchema,
  /** Launch audience is 18+ until verifiable parental consent exists (docs/prd.md §8, L-06). */
  confirmsAdult: z.literal(true),
  acceptedTermsVersion: z.literal(CURRENT_TERMS_VERSION),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

/** Deliberately identical for new and existing emails (no account enumeration). */
export const signupResponseSchema = z.object({ status: z.literal('verification_sent') });

export const verificationCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, {
    message: 'Enter the 6-digit code',
  });

export const verifyEmailRequestSchema = z.strictObject({
  email: emailSchema,
  code: verificationCodeSchema,
});

export const resendVerificationRequestSchema = z.strictObject({ email: emailSchema });

export const accountStatusSchema = z.enum(['pending_verification', 'pending_credential', 'active']);

export const meResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  status: accountStatusSchema,
  createdAt: z.iso.datetime(),
  security: z.object({
    hasPassword: z.boolean(),
    passkeyCount: z.number().int().nonnegative(),
    totpEnabled: z.boolean(),
    recoveryCodesRemaining: z.number().int().nonnegative(),
  }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const visibilitySchema = z.enum(['everyone', 'contacts', 'nobody']);

/** Privacy settings stored in Phase 2; enforcement arrives with the features they govern. */
export const privacySettingsSchema = z.strictObject({
  profilePhoto: visibilitySchema,
  lastSeen: visibilitySchema,
  onlineStatus: z.enum(['same_as_last_seen', 'nobody']),
  readReceipts: z.boolean(),
  groupInvites: visibilitySchema,
  calls: visibilitySchema,
  /**
   * When to relay calls through Tessera's TURN servers so the other person never learns your IP
   * address (docs/calling.md §2): always, unless you verified their safety number, or never.
   * Enforced by your own device (it offers only relayed network paths).
   */
  callRelay: z.enum(['always', 'unverified', 'never']).default('unverified'),
  discoverableByUsername: z.boolean(),
});
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  profilePhoto: 'contacts',
  lastSeen: 'contacts',
  onlineStatus: 'same_as_last_seen',
  readReceipts: true,
  groupInvites: 'contacts',
  calls: 'contacts',
  callRelay: 'unverified',
  discoverableByUsername: true,
};
