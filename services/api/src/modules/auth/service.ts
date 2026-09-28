import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import { ipPrefix, userAgentSummary } from '../../platform/client-info.js';
import type { Mailer, EmailMessage } from '../../platform/email.js';
import type { AuthenticatedSession, SessionStage } from '../../platform/http/routes.js';
import { constantTimeEqual, randomToken, sha256, type SecretBox } from '../../platform/secrets.js';
import type { AccountService, Account, RequestMeta } from '../accounts/index.js';
import type { AuditLog } from '../audit/index.js';

import { newSignInEmail, passwordResetEmail, securityNoticeEmail } from './emails.js';
import type { LoginEvents, LoginMethod } from './login-events.js';
import type { PasskeyService } from './passkeys.js';
import { assertStrongPassword, type PasswordHasher } from './passwords.js';
import {
  formatRecoveryCode,
  generateRecoveryCode,
  RECOVERY_CODE_COUNT,
  recoveryCodeDigest,
} from './recovery-codes.js';
import type { ClientInfo, IssuedSession, SessionService } from './sessions.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

type Executor = Kysely<Database> | Transaction<Database>;

export interface SecondFactor {
  readonly totpCode?: string | undefined;
  readonly recoveryCode?: string | undefined;
}

export interface AuthServiceDeps {
  readonly db: Kysely<Database>;
  readonly accounts: AccountService;
  readonly sessions: SessionService;
  readonly passwords: PasswordHasher;
  readonly passkeys: PasskeyService;
  readonly loginEvents: LoginEvents;
  readonly secretBox: SecretBox;
  readonly audit: AuditLog;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly publicWebUrl: string;
}

const RESET_TTL_MS = 30 * 60_000;

/** Result of a first-factor login step. */
export interface LoginResult {
  readonly stage: SessionStage;
  readonly session: IssuedSession;
}

/**
 * Authentication flows (docs/authentication.md §3). All credential changes are audited and
 * trigger a security notice; all privilege changes rotate the session.
 */
export class AuthService {
  readonly #d: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.#d = deps;
  }

  // ---- sessions for other modules ------------------------------------------------------------

  issueSetupSession(
    userId: string,
    client: ClientInfo,
    trx: Transaction<Database>,
  ): Promise<IssuedSession> {
    return this.#d.sessions.issue(userId, 'credential_setup', client, {
      reauthenticated: true,
      executor: trx,
    });
  }

  async summary(userId: string): Promise<{
    hasPassword: boolean;
    passkeyCount: number;
    totpEnabled: boolean;
    recoveryCodesRemaining: number;
  }> {
    const [password, passkeyCount, totp, codes] = await Promise.all([
      this.#d.db
        .selectFrom('password_credentials')
        .select('user_id')
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      this.#d.passkeys.count(userId),
      this.#totpRow(userId),
      this.#d.db
        .selectFrom('recovery_codes')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      hasPassword: password !== undefined,
      passkeyCount,
      totpEnabled: totp?.confirmed_at != null,
      recoveryCodesRemaining: Number(codes.n),
    };
  }

  // ---- first credential / password -----------------------------------------------------------

  /**
   * Sets the first password (setup stage → active) or changes it (active + step-up). Changing a
   * password signs out every other session.
   */
  async setPassword(
    session: AuthenticatedSession,
    password: string,
    client: ClientInfo,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const account = await this.#requireAccount(session.userId);
    assertStrongPassword(password, [account.username, account.email]);
    const hashed = await this.#d.passwords.hash(password);
    const firstCredential = session.stage === 'credential_setup';

    const issued = await this.#d.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('password_credentials')
        .values({ user_id: account.id, hash: hashed.hash, pepper_id: hashed.pepperId })
        .onConflict((c) =>
          c
            .column('user_id')
            .doUpdateSet({ hash: hashed.hash, pepper_id: hashed.pepperId, updated_at: new Date() }),
        )
        .execute();
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: firstCredential ? 'auth.password_set' : 'auth.password_changed',
          requestId: meta.requestId,
        },
        trx,
      );
      if (firstCredential) await this.#d.accounts.activate(account.id, trx, meta);
      else
        await this.#d.sessions.revokeAll(account.id, 'password_changed', {
          exceptId: session.id,
          executor: trx,
        });
      return this.#d.sessions.rotate(session, 'active', client, {
        reauthenticated: true,
        executor: trx,
      });
    });
    this.#d.sessions.notifyRevoked(account.id);
    if (!firstCredential)
      await this.#notify(securityNoticeEmail(account.email, 'Your password was changed'));
    return issued;
  }

  // ---- password login + MFA ------------------------------------------------------------------

  async loginWithPassword(
    identifier: string,
    password: string,
    client: ClientInfo,
  ): Promise<LoginResult> {
    const account = await this.#d.accounts.byIdentifier(identifier);
    const credential =
      account?.status === 'active'
        ? await this.#d.db
            .selectFrom('password_credentials')
            .select(['hash', 'pepper_id'])
            .where('user_id', '=', account.id)
            .executeTakeFirst()
        : undefined;

    if (account === null || credential === undefined) {
      await this.#d.passwords.burn(password); // equalise timing with real verifications
      await this.#d.loginEvents.failure(account?.id ?? null, 'password', client);
      throw new AppError('INVALID_CREDENTIALS');
    }
    const result = await this.#d.passwords.verify(password, {
      hash: credential.hash,
      pepperId: credential.pepper_id,
    });
    if (!result.valid) {
      await this.#d.loginEvents.failure(account.id, 'password', client);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (result.needsRehash) {
      const upgraded = await this.#d.passwords.hash(password);
      await this.#d.db
        .updateTable('password_credentials')
        .set({ hash: upgraded.hash, pepper_id: upgraded.pepperId, updated_at: new Date() })
        .where('user_id', '=', account.id)
        .execute();
    }

    if ((await this.#totpRow(account.id))?.confirmed_at != null) {
      const session = await this.#d.sessions.issue(account.id, 'mfa_pending', client, {
        reauthenticated: false,
      });
      return { stage: 'mfa_pending', session };
    }
    return { stage: 'active', session: await this.#completeLogin(account, 'password', client) };
  }

  async completeMfa(
    session: AuthenticatedSession,
    factor: SecondFactor,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const account = await this.#requireAccount(session.userId);
    const method = await this.#d.db
      .transaction()
      .execute(async (trx) => this.#checkSecondFactor(trx, account.id, factor));
    if (method === null) {
      await this.#d.loginEvents.failure(account.id, 'mfa', client, true);
      throw new AppError('INVALID_CODE');
    }
    await this.#d.sessions.revoke(account.id, session.id, 'rotated');
    return this.#completeLogin(account, method, client);
  }

  // ---- passkeys ------------------------------------------------------------------------------

  async passkeyRegistrationOptions(
    session: AuthenticatedSession,
  ): Promise<{ flowId: string; options: unknown }> {
    const account = await this.#requireAccount(session.userId);
    return this.#d.passkeys.registrationOptions(
      { id: account.id, username: account.username },
      session.id,
    );
  }

  async registerPasskey(
    session: AuthenticatedSession,
    input: { flowId: string; name: string; response: Record<string, unknown> },
    client: ClientInfo,
    meta: RequestMeta,
  ): Promise<IssuedSession | null> {
    const account = await this.#requireAccount(session.userId);
    const firstCredential = session.stage === 'credential_setup';
    const issued = await this.#d.db.transaction().execute(async (trx) => {
      const passkeyId = await this.#d.passkeys.register(
        input.flowId,
        { userId: account.id, sessionId: session.id },
        input.name,
        input.response,
        trx,
      );
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: 'auth.passkey_added',
          targetKind: 'passkey',
          targetId: passkeyId,
          requestId: meta.requestId,
        },
        trx,
      );
      if (!firstCredential) return null;
      await this.#d.accounts.activate(account.id, trx, meta);
      return this.#d.sessions.rotate(session, 'active', client, {
        reauthenticated: true,
        executor: trx,
      });
    });
    if (!firstCredential) {
      await this.#notify(
        securityNoticeEmail(account.email, 'A passkey was added', [`Name: ${input.name}`]),
      );
    }
    return issued;
  }

  async loginWithPasskey(
    flowId: string,
    response: Record<string, unknown>,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    let verified: { userId: string };
    try {
      verified = await this.#d.passkeys.authenticate(flowId, 'login', response, null);
    } catch (error) {
      await this.#d.loginEvents.failure(null, 'passkey', client);
      throw error;
    }
    const account = await this.#requireAccount(verified.userId);
    if (account.status !== 'active') throw new AppError('INVALID_CREDENTIALS');
    // A user-verified passkey is itself multi-factor (possession + biometric/PIN).
    return this.#completeLogin(account, 'passkey', client);
  }

  async removePasskey(
    session: AuthenticatedSession,
    passkeyId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const account = await this.#requireAccount(session.userId);
    await this.#d.db.transaction().execute(async (trx) => {
      await this.#lockCredentials(trx, account.id);
      const remaining = await this.#credentialCount(trx, account.id);
      const removed = await this.#d.passkeys.remove(account.id, passkeyId, trx);
      if (!removed) throw new AppError('NOT_FOUND');
      if (remaining <= 1) throw new AppError('LAST_CREDENTIAL');
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: 'auth.passkey_removed',
          targetKind: 'passkey',
          targetId: passkeyId,
          requestId: meta.requestId,
        },
        trx,
      );
    });
    await this.#notify(securityNoticeEmail(account.email, 'A passkey was removed'));
  }

  // ---- step-up re-authentication -------------------------------------------------------------

  async reauthenticateWithPassword(
    session: AuthenticatedSession,
    password: string,
    factor: SecondFactor,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const credential = await this.#d.db
      .selectFrom('password_credentials')
      .select(['hash', 'pepper_id'])
      .where('user_id', '=', session.userId)
      .executeTakeFirst();
    if (credential === undefined) {
      await this.#d.passwords.burn(password);
      throw new AppError('INVALID_CREDENTIALS');
    }
    const result = await this.#d.passwords.verify(password, {
      hash: credential.hash,
      pepperId: credential.pepper_id,
    });
    if (!result.valid) {
      await this.#d.loginEvents.failure(session.userId, 'password', client);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if ((await this.#totpRow(session.userId))?.confirmed_at != null) {
      const method = await this.#d.db
        .transaction()
        .execute((trx) => this.#checkSecondFactor(trx, session.userId, factor));
      if (method === null) {
        await this.#d.loginEvents.failure(session.userId, 'mfa', client, true);
        throw new AppError('INVALID_CODE', {
          detail: 'Enter a valid authentication or recovery code.',
        });
      }
    }
    return this.#d.sessions.rotate(session, 'active', client, { reauthenticated: true });
  }

  async reauthenticateWithPasskey(
    session: AuthenticatedSession,
    flowId: string,
    response: Record<string, unknown>,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    await this.#d.passkeys.authenticate(flowId, 'reauth', response, {
      id: session.id,
      userId: session.userId,
    });
    return this.#d.sessions.rotate(session, 'active', client, { reauthenticated: true });
  }

  // ---- TOTP and recovery codes ---------------------------------------------------------------

  async beginTotpSetup(
    session: AuthenticatedSession,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const account = await this.#requireAccount(session.userId);
    const existing = await this.#totpRow(account.id);
    if (existing?.confirmed_at != null) {
      throw new AppError('CONFLICT', { detail: 'Two-factor authentication is already enabled.' });
    }
    const secret = generateTotpSecret();
    const sealed = this.#d.secretBox.seal(Buffer.from(secret, 'utf8'), `totp:${account.id}`);
    await this.#d.db
      .insertInto('totp_credentials')
      .values({ user_id: account.id, secret_encrypted: sealed })
      .onConflict((c) =>
        c.column('user_id').doUpdateSet({ secret_encrypted: sealed, created_at: new Date() }),
      )
      .execute();
    return { secret, otpauthUri: totpUri(secret, account.username) };
  }

  async confirmTotp(
    session: AuthenticatedSession,
    code: string,
    meta: RequestMeta,
  ): Promise<string[]> {
    const account = await this.#requireAccount(session.userId);
    const codes = await this.#d.db.transaction().execute(async (trx) => {
      const row = await this.#totpRow(account.id, trx, true);
      if (row?.confirmed_at !== null)
        throw new AppError('CONFLICT', { detail: 'Start setup first.' });
      const step = verifyTotp(this.#openTotp(account.id, row.secret_encrypted), code, null);
      if (step === null) throw new AppError('INVALID_CODE');
      await trx
        .updateTable('totp_credentials')
        .set({ confirmed_at: new Date(), last_used_step: step })
        .where('user_id', '=', account.id)
        .execute();
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: 'auth.totp_enabled',
          requestId: meta.requestId,
        },
        trx,
      );
      return this.#replaceRecoveryCodes(trx, account.id, meta);
    });
    await this.#notify(
      securityNoticeEmail(account.email, 'Two-factor authentication was turned on'),
    );
    return codes;
  }

  async disableTotp(session: AuthenticatedSession, meta: RequestMeta): Promise<void> {
    const account = await this.#requireAccount(session.userId);
    await this.#d.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom('totp_credentials')
        .where('user_id', '=', account.id)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      await trx.deleteFrom('recovery_codes').where('user_id', '=', account.id).execute();
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: 'auth.totp_disabled',
          requestId: meta.requestId,
        },
        trx,
      );
    });
    await this.#notify(
      securityNoticeEmail(account.email, 'Two-factor authentication was turned off'),
    );
  }

  async regenerateRecoveryCodes(
    session: AuthenticatedSession,
    meta: RequestMeta,
  ): Promise<string[]> {
    const account = await this.#requireAccount(session.userId);
    const codes = await this.#d.db.transaction().execute(async (trx) => {
      if ((await this.#totpRow(account.id, trx))?.confirmed_at == null) {
        throw new AppError('CONFLICT', { detail: 'Turn on two-factor authentication first.' });
      }
      return this.#replaceRecoveryCodes(trx, account.id, meta);
    });
    await this.#notify(securityNoticeEmail(account.email, 'New recovery codes were generated'));
    return codes;
  }

  // ---- password reset ------------------------------------------------------------------------

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const account = await this.#d.accounts.byEmail(email);
    if (account?.status !== 'active') return;
    const token = randomToken(32);
    await this.#d.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('password_resets')
        .set({ consumed_at: new Date() })
        .where('user_id', '=', account.id)
        .where('consumed_at', 'is', null)
        .execute();
      await trx
        .insertInto('password_resets')
        .values({
          id: newId(),
          user_id: account.id,
          token_digest: sha256(token),
          expires_at: new Date(Date.now() + RESET_TTL_MS),
        })
        .execute();
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: 'auth.password_reset_requested',
          requestId: meta.requestId,
        },
        trx,
      );
    });
    // The token travels in the URL fragment, which browsers never send to servers or in Referer.
    const link = `${this.#d.publicWebUrl.replace(/\/$/, '')}/reset-password#token=${token}`;
    await this.#d.mailer.send(passwordResetEmail(account.email, link));
  }

  async completePasswordReset(
    token: string,
    password: string,
    factor: SecondFactor,
    meta: RequestMeta,
  ): Promise<void> {
    const account = await this.#d.db.transaction().execute(async (trx) => {
      const reset = await trx
        .selectFrom('password_resets')
        .selectAll()
        .where('token_digest', '=', sha256(token))
        .where('consumed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (reset === undefined || reset.expires_at.getTime() < Date.now())
        throw new AppError('INVALID_CODE');
      const owner = await this.#requireAccount(reset.user_id, trx);
      // An email inbox alone must not bypass two-factor authentication.
      if ((await this.#totpRow(owner.id, trx))?.confirmed_at != null) {
        if ((await this.#checkSecondFactor(trx, owner.id, factor)) === null) {
          throw new AppError('INVALID_CODE', {
            detail: 'Enter a valid authentication or recovery code.',
          });
        }
      }
      assertStrongPassword(password, [owner.username, owner.email]);
      const hashed = await this.#d.passwords.hash(password);
      await trx
        .insertInto('password_credentials')
        .values({ user_id: owner.id, hash: hashed.hash, pepper_id: hashed.pepperId })
        .onConflict((c) =>
          c
            .column('user_id')
            .doUpdateSet({ hash: hashed.hash, pepper_id: hashed.pepperId, updated_at: new Date() }),
        )
        .execute();
      await trx
        .updateTable('password_resets')
        .set({ consumed_at: new Date() })
        .where('id', '=', reset.id)
        .execute();
      await this.#d.sessions.revokeAll(owner.id, 'password_reset', { executor: trx });
      await this.#d.audit.record(
        {
          actorKind: 'user',
          actorId: owner.id,
          action: 'auth.password_reset_completed',
          requestId: meta.requestId,
        },
        trx,
      );
      return owner;
    });
    this.#d.sessions.notifyRevoked(account.id);
    await this.#notify(
      securityNoticeEmail(account.email, 'Your password was reset', [
        'All sessions were signed out.',
      ]),
    );
  }

  // ---- internals -----------------------------------------------------------------------------

  async #completeLogin(
    account: Account,
    method: LoginMethod,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const session = await this.#d.sessions.issue(account.id, 'active', client, {
      reauthenticated: true,
    });
    const { unfamiliar } = await this.#d.loginEvents.success(account.id, method, client);
    if (unfamiliar) {
      await this.#notify(
        newSignInEmail(account.email, {
          device: userAgentSummary(client.userAgent),
          network: ipPrefix(client.ip),
          at: new Date(),
        }),
      );
    }
    return session;
  }

  /** Verifies a TOTP code (with replay protection) or consumes a recovery code. */
  async #checkSecondFactor(
    trx: Transaction<Database>,
    userId: string,
    factor: SecondFactor,
  ): Promise<LoginMethod | null> {
    if (factor.totpCode !== undefined) {
      const row = await this.#totpRow(userId, trx, true);
      if (row?.confirmed_at == null) return null;
      const step = verifyTotp(
        this.#openTotp(userId, row.secret_encrypted),
        factor.totpCode,
        row.last_used_step === null ? null : Number(row.last_used_step),
      );
      if (step === null) return null;
      await trx
        .updateTable('totp_credentials')
        .set({ last_used_step: step })
        .where('user_id', '=', userId)
        .execute();
      return 'mfa';
    }
    if (factor.recoveryCode !== undefined) {
      const digest = recoveryCodeDigest(factor.recoveryCode);
      const codes = await trx
        .selectFrom('recovery_codes')
        .select(['id', 'code_digest'])
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .forUpdate()
        .execute();
      const match = codes.find((code) => constantTimeEqual(code.code_digest, digest));
      if (match === undefined) return null;
      await trx
        .updateTable('recovery_codes')
        .set({ used_at: new Date() })
        .where('id', '=', match.id)
        .execute();
      await this.#d.audit.record(
        { actorKind: 'user', actorId: userId, action: 'auth.recovery_code_used' },
        trx,
      );
      return 'recovery_code';
    }
    return null;
  }

  async #replaceRecoveryCodes(
    trx: Transaction<Database>,
    userId: string,
    meta: RequestMeta,
  ): Promise<string[]> {
    await trx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await trx
      .insertInto('recovery_codes')
      .values(
        codes.map((code) => ({
          id: newId(),
          user_id: userId,
          code_digest: recoveryCodeDigest(code),
        })),
      )
      .execute();
    await this.#d.audit.record(
      {
        actorKind: 'user',
        actorId: userId,
        action: 'auth.recovery_codes_generated',
        requestId: meta.requestId,
      },
      trx,
    );
    return codes.map(formatRecoveryCode);
  }

  #openTotp(userId: string, sealed: string): string {
    return this.#d.secretBox.open(sealed, `totp:${userId}`).toString('utf8');
  }

  async #totpRow(userId: string, executor: Executor = this.#d.db, lock = false) {
    let query = executor
      .selectFrom('totp_credentials')
      .select(['secret_encrypted', 'confirmed_at', 'last_used_step'])
      .where('user_id', '=', userId);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Serialises credential changes per user (prevents removing the last two credentials concurrently). */
  async #lockCredentials(trx: Transaction<Database>, userId: string): Promise<void> {
    await trx
      .selectFrom('passkeys')
      .select('id')
      .where('user_id', '=', userId)
      .forUpdate()
      .execute();
    await trx
      .selectFrom('password_credentials')
      .select('user_id')
      .where('user_id', '=', userId)
      .forUpdate()
      .execute();
  }

  async #credentialCount(executor: Executor, userId: string): Promise<number> {
    const password = await executor
      .selectFrom('password_credentials')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return (password === undefined ? 0 : 1) + (await this.#d.passkeys.count(userId, executor));
  }

  async #requireAccount(userId: string, executor?: Executor): Promise<Account> {
    const account = await this.#d.accounts.byId(userId, executor);
    if (account === null) throw new AppError('UNAUTHENTICATED');
    return account;
  }

  /** Security notices are best-effort: a mail outage must not block the security action itself. */
  async #notify(message: EmailMessage): Promise<void> {
    try {
      await this.#d.mailer.send(message);
    } catch (error) {
      this.#d.logger.error('auth.security_notice_failed', this.#d.logger.errorFields(error));
    }
  }
}
