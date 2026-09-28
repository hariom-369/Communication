import { AppError } from '@tessera/platform';
import {
  idSchema,
  loginRequestSchema,
  mfaRequestSchema,
  okResponseSchema,
  passkeyListSchema,
  passkeyLoginOptionsSchema,
  passkeyLoginVerifySchema,
  passkeyOptionsResponseSchema,
  passkeyRegisterVerifySchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  reauthPasswordRequestSchema,
  recoveryCodesResponseSchema,
  sessionListSchema,
  sessionStateSchema,
  setPasswordRequestSchema,
  totpCodeSchema,
  totpSetupResponseSchema,
} from '@tessera/validation';
import { z } from 'zod';

import {
  defineRoute,
  ownAccount,
  publicAccess,
  type RouteContext,
  type RouteDefinition,
} from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { PasskeyService } from './passkeys.js';
import type { AuthService } from './service.js';
import type { SessionService } from './sessions.js';

export interface AuthModuleDeps {
  readonly auth: AuthService;
  readonly sessions: SessionService;
  readonly passkeys: PasskeyService;
}

/** docs/authentication.md §7. Authentication limits fail closed when Valkey is unavailable. */
const limits = {
  loginIp: {
    name: 'auth.login.ip',
    limit: 30,
    periodMs: 60_000,
    burst: 30,
    onStoreFailure: 'closed',
  },
  loginIdentifierMinute: {
    name: 'auth.login.id.m',
    limit: 5,
    periodMs: 60_000,
    burst: 5,
    onStoreFailure: 'closed',
  },
  loginIdentifierHour: {
    name: 'auth.login.id.h',
    limit: 20,
    periodMs: 3_600_000,
    burst: 20,
    onStoreFailure: 'closed',
  },
  mfaSession: {
    name: 'auth.mfa.session',
    limit: 5,
    periodMs: 300_000,
    burst: 5,
    onStoreFailure: 'closed',
  },
  mfaUser: {
    name: 'auth.mfa.user',
    limit: 10,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  passkeyIp: {
    name: 'auth.passkey.ip',
    limit: 20,
    periodMs: 60_000,
    burst: 20,
    onStoreFailure: 'closed',
  },
  reauthUser: {
    name: 'auth.reauth.user',
    limit: 10,
    periodMs: 900_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  credentialChange: {
    name: 'auth.credentials',
    limit: 20,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  resetIp: {
    name: 'auth.reset.ip',
    limit: 10,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  resetEmail: {
    name: 'auth.reset.email',
    limit: 3,
    periodMs: 3_600_000,
    burst: 3,
    onStoreFailure: 'closed',
  },
  sessionOps: {
    name: 'auth.sessions',
    limit: 60,
    periodMs: 60_000,
    burst: 30,
    onStoreFailure: 'open',
  },
  read: { name: 'auth.read', limit: 120, periodMs: 60_000, burst: 60, onStoreFailure: 'open' },
} satisfies Record<string, RateLimitPolicy>;

const client = (context: RouteContext) => ({ ip: context.clientIp, userAgent: context.userAgent });
const meta = (context: RouteContext) => ({ requestId: context.requestId });
const idParams = z.strictObject({ id: idSchema });

export function authRoutes(deps: AuthModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'auth.login_password',
      method: 'POST',
      url: '/api/v1/auth/login',
      summary: 'Sign in with email/username and password',
      tags: ['auth'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: limits.loginIp,
      audit: { kind: 'none', reason: 'Recorded in login_events (security event log)' },
      schema: { body: loginRequestSchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        const subject = `id:${body.identifier.toLowerCase()}`;
        await context.rateLimit(limits.loginIdentifierMinute, subject);
        await context.rateLimit(limits.loginIdentifierHour, subject);
        const result = await deps.auth.loginWithPassword(
          body.identifier,
          body.password,
          client(context),
        );
        context.setSessionCookie(result.session.token, result.session.expiresAt);
        return { stage: result.stage };
      },
    }),
    defineRoute({
      id: 'auth.login_mfa',
      method: 'POST',
      url: '/api/v1/auth/login/mfa',
      summary: 'Complete sign-in with an authenticator or recovery code',
      tags: ['auth'],
      auth: { kind: 'session', stages: ['mfa_pending'] },
      authorize: ownAccount,
      rateLimit: limits.loginIp,
      audit: { kind: 'records', actions: ['auth.recovery_code_used'] },
      schema: { body: mfaRequestSchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await context.rateLimit(limits.mfaSession, `session:${context.session.id}`);
        await context.rateLimit(limits.mfaUser, `user:${context.session.userId}`);
        const issued = await deps.auth.completeMfa(context.session, body, client(context));
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.passkey_login_options',
      method: 'POST',
      url: '/api/v1/auth/passkeys/login/options',
      summary: 'WebAuthn options to sign in or re-authenticate with a passkey',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: limits.passkeyIp,
      audit: { kind: 'none', reason: 'Issues a single-use challenge only' },
      schema: { body: passkeyLoginOptionsSchema, response: passkeyOptionsResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        if (body.purpose === 'reauth' && context.session?.stage !== 'active')
          throw new AppError('UNAUTHENTICATED');
        const flow = await deps.passkeys.authenticationOptions(
          body.purpose,
          body.purpose === 'reauth' ? context.session : null,
        );
        return { flowId: flow.flowId, options: flow.options as Record<string, unknown> };
      },
    }),
    defineRoute({
      id: 'auth.passkey_login_verify',
      method: 'POST',
      url: '/api/v1/auth/passkeys/login/verify',
      summary: 'Sign in with a passkey assertion',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: limits.passkeyIp,
      audit: { kind: 'none', reason: 'Recorded in login_events (security event log)' },
      schema: { body: passkeyLoginVerifySchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        const issued = await deps.auth.loginWithPasskey(
          body.flowId,
          body.response,
          client(context),
        );
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.reauth_password',
      method: 'POST',
      url: '/api/v1/auth/reauth/password',
      summary: 'Confirm identity with password (and 2FA if enabled) before a sensitive action',
      tags: ['auth'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.sessionOps,
      audit: { kind: 'none', reason: 'Recorded in login_events on failure; no state change' },
      schema: { body: reauthPasswordRequestSchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await context.rateLimit(limits.reauthUser, `user:${context.session.userId}`);
        const issued = await deps.auth.reauthenticateWithPassword(
          context.session,
          body.password,
          body,
          client(context),
        );
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.reauth_passkey',
      method: 'POST',
      url: '/api/v1/auth/reauth/passkey',
      summary: 'Confirm identity with a passkey before a sensitive action',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.sessionOps,
      audit: { kind: 'none', reason: 'No state change' },
      schema: { body: passkeyLoginVerifySchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await context.rateLimit(limits.reauthUser, `user:${context.session.userId}`);
        const issued = await deps.auth.reauthenticateWithPasskey(
          context.session,
          body.flowId,
          body.response,
          client(context),
        );
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.password_set_initial',
      method: 'POST',
      url: '/api/v1/auth/password/initial',
      summary: 'Create the first password during sign-up',
      tags: ['auth'],
      auth: { kind: 'session', stages: ['credential_setup'] },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.password_set', 'account.activated'] },
      schema: { body: setPasswordRequestSchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        const issued = await deps.auth.setPassword(
          context.session,
          body.password,
          client(context),
          meta(context),
        );
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.password_change',
      method: 'PUT',
      url: '/api/v1/auth/password',
      summary: 'Change password (signs out other sessions)',
      tags: ['auth'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.password_changed'] },
      schema: { body: setPasswordRequestSchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        const issued = await deps.auth.setPassword(
          context.session,
          body.password,
          client(context),
          meta(context),
        );
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.passkey_register_options',
      method: 'POST',
      url: '/api/v1/auth/passkeys/register/options',
      summary: 'WebAuthn options to create a passkey',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'session', stages: ['credential_setup', 'active'] },
      authorize: {
        name: 'setup_or_recent_reauth',
        allows: (context) =>
          context.session?.stage === 'credential_setup' ||
          (context.session?.reauthenticatedAt != null &&
            Date.now() - context.session.reauthenticatedAt.getTime() <= 10 * 60_000),
      },
      rateLimit: limits.credentialChange,
      audit: { kind: 'none', reason: 'Issues a single-use challenge only' },
      schema: { body: z.strictObject({}), response: passkeyOptionsResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => {
        const flow = await deps.auth.passkeyRegistrationOptions(context.session);
        return { flowId: flow.flowId, options: flow.options as Record<string, unknown> };
      },
    }),
    defineRoute({
      id: 'auth.passkey_register_verify',
      method: 'POST',
      url: '/api/v1/auth/passkeys/register/verify',
      summary: 'Save a new passkey',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'session', stages: ['credential_setup', 'active'] },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.passkey_added', 'account.activated'] },
      schema: { body: passkeyRegisterVerifySchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        // Binding to the options call (same session) enforces the setup/step-up check made there.
        const issued = await deps.auth.registerPasskey(
          context.session,
          body,
          client(context),
          meta(context),
        );
        if (issued !== null) context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'active' as const };
      },
    }),
    defineRoute({
      id: 'auth.passkeys_list',
      method: 'GET',
      url: '/api/v1/auth/passkeys',
      summary: 'Passkeys of the signed-in account',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: passkeyListSchema },
      successStatus: 200,
      handler: async (_input, context) => ({
        passkeys: (await deps.passkeys.list(context.session.userId)).map((passkey) => ({
          id: passkey.id,
          name: passkey.name,
          createdAt: passkey.createdAt.toISOString(),
          lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
          synced: passkey.synced,
        })),
      }),
    }),
    defineRoute({
      id: 'auth.passkey_delete',
      method: 'DELETE',
      url: '/api/v1/auth/passkeys/:id',
      summary: 'Remove a passkey (not the last sign-in method)',
      tags: ['auth', 'passkeys'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.passkey_removed'] },
      schema: { params: idParams, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await deps.auth.removePasskey(context.session, params.id, meta(context));
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'auth.totp_setup',
      method: 'POST',
      url: '/api/v1/auth/totp/setup',
      summary: 'Start authenticator-app (TOTP) enrolment',
      tags: ['auth', 'mfa'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'none', reason: 'Unconfirmed secret; enabling is audited on confirm' },
      schema: { body: z.strictObject({}), response: totpSetupResponseSchema },
      successStatus: 200,
      handler: (_input, context) => deps.auth.beginTotpSetup(context.session),
    }),
    defineRoute({
      id: 'auth.totp_confirm',
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      summary: 'Confirm TOTP enrolment; returns recovery codes once',
      tags: ['auth', 'mfa'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.totp_enabled', 'auth.recovery_codes_generated'] },
      schema: {
        body: z.strictObject({ code: totpCodeSchema }),
        response: recoveryCodesResponseSchema,
      },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await context.rateLimit(limits.mfaUser, `user:${context.session.userId}`);
        return {
          recoveryCodes: await deps.auth.confirmTotp(context.session, body.code, meta(context)),
        };
      },
    }),
    defineRoute({
      id: 'auth.totp_disable',
      method: 'DELETE',
      url: '/api/v1/auth/totp',
      summary: 'Turn off authenticator-app 2FA',
      tags: ['auth', 'mfa'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.totp_disabled'] },
      schema: { response: okResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => {
        await deps.auth.disableTotp(context.session, meta(context));
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'auth.recovery_codes_regenerate',
      method: 'POST',
      url: '/api/v1/auth/recovery-codes',
      summary: 'Replace recovery codes; returns the new codes once',
      tags: ['auth', 'mfa'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.credentialChange,
      audit: { kind: 'records', actions: ['auth.recovery_codes_generated'] },
      schema: { body: z.strictObject({}), response: recoveryCodesResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => ({
        recoveryCodes: await deps.auth.regenerateRecoveryCodes(context.session, meta(context)),
      }),
    }),
    defineRoute({
      id: 'auth.password_reset_request',
      method: 'POST',
      url: '/api/v1/auth/password-reset',
      summary: 'Email a password reset link (same response for every address)',
      tags: ['auth'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: limits.resetIp,
      audit: { kind: 'records', actions: ['auth.password_reset_requested'] },
      schema: { body: passwordResetRequestSchema, response: okResponseSchema },
      successStatus: 202,
      handler: async ({ body }, context) => {
        await context.rateLimit(limits.resetEmail, `email:${body.email.toLowerCase()}`);
        await deps.auth.requestPasswordReset(body.email, meta(context));
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'auth.password_reset_complete',
      method: 'POST',
      url: '/api/v1/auth/password-reset/complete',
      summary: 'Set a new password with a reset token (signs out all sessions)',
      tags: ['auth'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: limits.resetIp,
      audit: { kind: 'records', actions: ['auth.password_reset_completed'] },
      schema: { body: passwordResetCompleteSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await deps.auth.completePasswordReset(body.token, body.password, body, meta(context));
        context.clearSessionCookie();
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'auth.logout',
      method: 'POST',
      url: '/api/v1/auth/logout',
      summary: 'Sign out of this session',
      tags: ['auth', 'sessions'],
      auth: { kind: 'session', stages: ['active', 'credential_setup', 'mfa_pending'] },
      authorize: ownAccount,
      rateLimit: limits.sessionOps,
      audit: { kind: 'none', reason: 'Session revocation is recorded on the session row' },
      schema: { body: z.strictObject({}), response: okResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => {
        await deps.sessions.revoke(context.session.userId, context.session.id, 'logout');
        context.clearSessionCookie();
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'auth.sessions_list',
      method: 'GET',
      url: '/api/v1/auth/sessions',
      summary: 'Active sessions of the signed-in account',
      tags: ['auth', 'sessions'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: sessionListSchema },
      successStatus: 200,
      handler: async (_input, context) => ({
        sessions: (await deps.sessions.list(context.session.userId)).map((session) => ({
          id: session.id,
          current: session.id === context.session.id,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeenAt.toISOString(),
          userAgent: session.userAgent,
          approximateLocation:
            session.ipPrefix === 'unknown' ? null : `Network ${session.ipPrefix}`,
        })),
      }),
    }),
    defineRoute({
      id: 'auth.session_revoke',
      method: 'DELETE',
      url: '/api/v1/auth/sessions/:id',
      summary: 'Sign out another session',
      tags: ['auth', 'sessions'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.sessionOps,
      audit: { kind: 'none', reason: 'Session revocation is recorded on the session row' },
      schema: { params: idParams, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        const revoked = await deps.sessions.revoke(
          context.session.userId,
          params.id,
          'user_revoked',
        );
        if (!revoked) throw new AppError('NOT_FOUND');
        if (params.id === context.session.id) context.clearSessionCookie();
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'auth.sessions_revoke_others',
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-others',
      summary: 'Sign out all other sessions',
      tags: ['auth', 'sessions'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.sessionOps,
      audit: { kind: 'none', reason: 'Session revocations are recorded on the session rows' },
      schema: { body: z.strictObject({}), response: z.object({ revoked: z.number().int() }) },
      successStatus: 200,
      handler: async (_input, context) => ({
        revoked: await deps.sessions.revokeAll(context.session.userId, 'user_revoked_others', {
          exceptId: context.session.id,
        }),
      }),
    }),
  ];
}
