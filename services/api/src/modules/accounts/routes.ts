import { AppError } from '@tessera/platform';
import {
  meResponseSchema,
  okResponseSchema,
  privacySettingsSchema,
  resendVerificationRequestSchema,
  sessionStateSchema,
  signupRequestSchema,
  signupResponseSchema,
  verifyEmailRequestSchema,
} from '@tessera/validation';
import type { Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import {
  defineRoute,
  ownAccount,
  publicAccess,
  type RouteDefinition,
} from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { AccountService } from './accounts.js';

/** Implemented by the auth module: issues the short-lived session used to add a first credential. */
export interface SetupSessionIssuer {
  issueSetupSession(
    userId: string,
    client: { ip: string; userAgent: string | undefined },
    trx: Transaction<Database>,
  ): Promise<{ token: string; expiresAt: Date }>;
}

/** Implemented by the auth module: credential overview for the account page. */
export interface SecuritySummaryProvider {
  summary(userId: string): Promise<{
    hasPassword: boolean;
    passkeyCount: number;
    totpEnabled: boolean;
    recoveryCodesRemaining: number;
  }>;
}

export interface AccountsModuleDeps {
  readonly accounts: AccountService;
  readonly sessions: SetupSessionIssuer;
  readonly security: SecuritySummaryProvider;
}

const perHour = (name: string, limit: number): RateLimitPolicy => ({
  name,
  limit,
  periodMs: 60 * 60_000,
  burst: limit,
  onStoreFailure: 'closed',
});

const readLimit: RateLimitPolicy = {
  name: 'accounts.read',
  limit: 120,
  periodMs: 60_000,
  burst: 60,
  onStoreFailure: 'open',
};

export function accountsRoutes(deps: AccountsModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'accounts.signup',
      method: 'POST',
      url: '/api/v1/accounts',
      summary: 'Start sign-up: sends an email verification code',
      tags: ['accounts'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      // Per-IP limits must tolerate shared addresses (CGNAT); per-email limits are strict.
      rateLimit: perHour('accounts.signup.ip', 30),
      audit: { kind: 'records', actions: ['account.created'] },
      schema: { body: signupRequestSchema, response: signupResponseSchema },
      successStatus: 202,
      handler: async ({ body }, context) => {
        await context.rateLimit(
          perHour('accounts.signup.email', 5),
          `email:${body.email.toLowerCase()}`,
        );
        await deps.accounts.signup(body, { requestId: context.requestId });
        return { status: 'verification_sent' as const };
      },
    }),
    defineRoute({
      id: 'accounts.resend_verification',
      method: 'POST',
      url: '/api/v1/accounts/resend-verification',
      summary: 'Send a new email verification code',
      tags: ['accounts'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: perHour('accounts.resend.ip', 10),
      audit: { kind: 'none', reason: 'No state change beyond a new single-use code' },
      schema: { body: resendVerificationRequestSchema, response: signupResponseSchema },
      successStatus: 202,
      handler: async ({ body }, context) => {
        await context.rateLimit(
          perHour('accounts.resend.email', 5),
          `email:${body.email.toLowerCase()}`,
        );
        await deps.accounts.resendVerification(body.email);
        return { status: 'verification_sent' as const };
      },
    }),
    defineRoute({
      id: 'accounts.verify_email',
      method: 'POST',
      url: '/api/v1/accounts/verify-email',
      summary: 'Verify the email code; starts a credential-setup session',
      tags: ['accounts'],
      auth: { kind: 'public' },
      authorize: publicAccess,
      rateLimit: perHour('accounts.verify.ip', 30),
      audit: { kind: 'records', actions: ['account.email_verified'] },
      schema: { body: verifyEmailRequestSchema, response: sessionStateSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await context.rateLimit(
          perHour('accounts.verify.email', 10),
          `email:${body.email.toLowerCase()}`,
        );
        const issued = await deps.accounts.verifyEmail(
          body.email,
          body.code,
          { requestId: context.requestId },
          (account, trx) =>
            deps.sessions.issueSetupSession(
              account.id,
              { ip: context.clientIp, userAgent: context.userAgent },
              trx,
            ),
        );
        context.setSessionCookie(issued.token, issued.expiresAt);
        return { stage: 'credential_setup' as const };
      },
    }),
    defineRoute({
      id: 'accounts.me',
      method: 'GET',
      url: '/api/v1/accounts/me',
      summary: 'The signed-in account',
      tags: ['accounts'],
      auth: { kind: 'session', whileSuspended: true, stages: ['active', 'credential_setup'] },
      authorize: ownAccount,
      rateLimit: readLimit,
      audit: { kind: 'none', reason: 'Read-only access to own account' },
      schema: { response: meResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => {
        const account = await deps.accounts.byId(context.session.userId);
        if (account === null) throw new AppError('UNAUTHENTICATED');
        return {
          id: account.id,
          username: account.username,
          email: account.email,
          status: account.status,
          createdAt: account.createdAt.toISOString(),
          security: await deps.security.summary(account.id),
        };
      },
    }),
    defineRoute({
      id: 'accounts.privacy_get',
      method: 'GET',
      url: '/api/v1/accounts/me/privacy',
      summary: 'Privacy settings of the signed-in account',
      tags: ['accounts', 'privacy'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: readLimit,
      audit: { kind: 'none', reason: 'Read-only access to own settings' },
      schema: { response: privacySettingsSchema },
      successStatus: 200,
      handler: (_input, context) => deps.accounts.privacySettings(context.session.userId),
    }),
    defineRoute({
      id: 'accounts.privacy_update',
      method: 'PUT',
      url: '/api/v1/accounts/me/privacy',
      summary: 'Replace privacy settings',
      tags: ['accounts', 'privacy'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: {
        name: 'accounts.privacy_update',
        limit: 30,
        periodMs: 60_000,
        burst: 10,
        onStoreFailure: 'open',
      },
      audit: { kind: 'records', actions: ['privacy.updated'] },
      schema: { body: privacySettingsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await deps.accounts.updatePrivacySettings(context.session.userId, body, {
          requestId: context.requestId,
        });
        return { ok: true as const };
      },
    }),
  ];
}
