import { z } from 'zod';

import { emailSchema, usernameSchema } from './accounts.js';

/** NIST SP 800-63B length bounds; strength is checked server-side (docs/authentication.md §2.1). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { message: `Use at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(PASSWORD_MAX_LENGTH, { message: `Use at most ${PASSWORD_MAX_LENGTH} characters` });

/** Login identifier: an email address or a username. */
export const identifierSchema = z.union([emailSchema, usernameSchema]);

export const sessionStageSchema = z.enum(['credential_setup', 'mfa_pending', 'active']);
export type SessionStage = z.infer<typeof sessionStageSchema>;

export const sessionStateSchema = z.object({ stage: sessionStageSchema });
export type SessionState = z.infer<typeof sessionStateSchema>;

export const loginRequestSchema = z.strictObject({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { message: 'Enter the 6-digit code' });

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replaceAll('-', '').replaceAll(' ', ''))
  .pipe(z.string().regex(/^[A-Z2-7]{10}$/, { message: 'Enter a recovery code' }));

export const mfaRequestSchema = z.union([
  z.strictObject({ totpCode: totpCodeSchema }),
  z.strictObject({ recoveryCode: recoveryCodeSchema }),
]);

export const setPasswordRequestSchema = z.strictObject({ password: passwordSchema });

/** Accounts with TOTP enabled must also present a second factor (code or recovery code). */
export const reauthPasswordRequestSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  totpCode: totpCodeSchema.optional(),
  recoveryCode: recoveryCodeSchema.optional(),
});

export const passwordResetRequestSchema = z.strictObject({ email: emailSchema });
export const passwordResetCompleteSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: passwordSchema,
  totpCode: totpCodeSchema.optional(),
  recoveryCode: recoveryCodeSchema.optional(),
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

/** WebAuthn JSON payloads are validated structurally by @simplewebauthn/server; we bound size. */
export const webauthnJsonSchema = z.record(z.string(), z.unknown());

export const passkeyOptionsResponseSchema = z.object({
  flowId: z.string(),
  options: webauthnJsonSchema,
});

export const passkeyRegisterVerifySchema = z.strictObject({
  flowId: z.string().max(64),
  name: z.string().trim().min(1).max(64),
  response: webauthnJsonSchema,
});

export const passkeyLoginOptionsSchema = z.strictObject({
  purpose: z.enum(['login', 'reauth']),
});

export const passkeyLoginVerifySchema = z.strictObject({
  flowId: z.string().max(64),
  response: webauthnJsonSchema,
});

export const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  synced: z.boolean(),
});
export const passkeyListSchema = z.object({ passkeys: z.array(passkeySchema) });

export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});

export const recoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });

export const sessionSchema = z.object({
  id: z.string(),
  current: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  userAgent: z.string(),
  approximateLocation: z.string().nullable(),
});
export const sessionListSchema = z.object({ sessions: z.array(sessionSchema) });
export type SessionSummary = z.infer<typeof sessionSchema>;

export { emailSchema, usernameSchema };
