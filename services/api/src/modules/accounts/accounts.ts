import { AppError } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  DEFAULT_PRIVACY_SETTINGS,
  privacySettingsSchema,
  type PrivacySettings,
  type SignupRequest,
} from '@tessera/validation';
import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import type { Mailer } from '../../platform/email.js';
import { constantTimeEqual, randomDigits, sha256 } from '../../platform/secrets.js';
import type { AuditLog } from '../audit/index.js';

import { existingAccountEmail, verificationEmail } from './emails.js';

type Executor = Kysely<Database> | Transaction<Database>;

export type AccountStatus = 'pending_verification' | 'pending_credential' | 'active';

export interface Account {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly status: AccountStatus;
  readonly createdAt: Date;
}

const CODE_TTL_MS = 15 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

function codeDigest(verificationId: string, code: string): Buffer {
  return sha256(`tessera-email-verification:${verificationId}:${code}`);
}

export interface RequestMeta {
  readonly requestId: string;
}

/**
 * Accounts: identities, email ownership, account status, privacy settings. Knows nothing about
 * credentials or sessions (those belong to the auth module).
 */
export class AccountService {
  readonly #db: Kysely<Database>;
  readonly #mailer: Mailer;
  readonly #audit: AuditLog;

  constructor(db: Kysely<Database>, mailer: Mailer, audit: AuditLog) {
    this.#db = db;
    this.#mailer = mailer;
    this.#audit = audit;
  }

  /**
   * Starts sign-up. The response is identical whether or not the email is already registered;
   * the owner of an existing account receives a notice instead of a code.
   */
  async signup(request: SignupRequest, meta: RequestMeta): Promise<void> {
    const outcome = await this.#db
      .transaction()
      .execute(async (trx) => this.#signupTransaction(trx, request, meta))
      .catch((error: unknown) => {
        // Concurrent sign-ups can race past the existence checks; the unique indexes decide.
        const constraint = (error as { code?: string; constraint?: string }).constraint;
        if ((error as { code?: string }).code !== '23505') throw error;
        if (constraint === 'users_username_key') throw new AppError('USERNAME_TAKEN');
        return { kind: 'raced' as const };
      });

    if (outcome.kind === 'exists') {
      await this.#mailer.send(existingAccountEmail(request.email));
    } else if (outcome.kind === 'code') {
      await this.#mailer.send(verificationEmail(request.email, request.username, outcome.code));
    }
  }

  async #signupTransaction(
    trx: Transaction<Database>,
    request: SignupRequest,
    meta: RequestMeta,
  ): Promise<{ kind: 'exists' } | { kind: 'code'; code: string }> {
    const existing = await trx
      .selectFrom('user_emails')
      .innerJoin('users', 'users.id', 'user_emails.user_id')
      .select(['users.id', 'users.status', 'users.username'])
      .where('user_emails.email', '=', request.email)
      .forUpdate()
      .executeTakeFirst();

    if (existing !== undefined && existing.status !== 'pending_verification') {
      return { kind: 'exists' as const };
    }

    const owner = await trx
      .selectFrom('users')
      .select('id')
      .where('username', '=', request.username)
      .executeTakeFirst();
    if (owner !== undefined && owner.id !== existing?.id) throw new AppError('USERNAME_TAKEN');

    let userId: string;
    if (existing === undefined) {
      userId = newId();
      await trx
        .insertInto('users')
        .values({
          id: userId,
          username: request.username,
          status: 'pending_verification',
          accepted_terms_version: request.acceptedTermsVersion,
          confirmed_adult_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('user_emails')
        .values({ user_id: userId, email: request.email })
        .execute();
      await trx
        .insertInto('privacy_settings')
        .values({ user_id: userId, settings: JSON.stringify(DEFAULT_PRIVACY_SETTINGS) })
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'account.created',
          requestId: meta.requestId,
        },
        trx,
      );
    } else {
      userId = existing.id;
      // An unverified registration can be restarted (e.g. typo in username, lost code).
      await trx
        .updateTable('users')
        .set({
          username: request.username,
          accepted_terms_version: request.acceptedTermsVersion,
          updated_at: new Date(),
        })
        .where('id', '=', userId)
        .execute();
    }
    const code = await this.#createCode(trx, userId);
    return { kind: 'code' as const, code };
  }

  /** Sends a new code if the address belongs to an account that still needs verification. */
  async resendVerification(email: string): Promise<void> {
    const pending = await this.#db.transaction().execute(async (trx) => {
      const account = await this.#byEmail(trx, email);
      if (account?.status !== 'pending_verification') return null;
      return { account, code: await this.#createCode(trx, account.id) };
    });
    if (pending !== null) {
      await this.#mailer.send(
        verificationEmail(pending.account.email, pending.account.username, pending.code),
      );
    }
  }

  /**
   * Verifies an email code. On success the account moves to `pending_credential` and the
   * callback runs inside the same transaction (the auth module issues a setup session there).
   * Any failure — unknown email, wrong, expired or exhausted code — is the same INVALID_CODE.
   */
  async verifyEmail<T>(
    email: string,
    code: string,
    meta: RequestMeta,
    onVerified: (account: Account, trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    const result = await this.#db.transaction().execute(async (trx) => {
      const account = await this.#byEmail(trx, email);
      if (account?.status !== 'pending_verification') return { ok: false as const };
      const verification = await trx
        .selectFrom('email_verifications')
        .selectAll()
        .where('user_id', '=', account.id)
        .where('consumed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (
        verification === undefined ||
        verification.expires_at.getTime() < Date.now() ||
        verification.attempts >= MAX_CODE_ATTEMPTS
      ) {
        return { ok: false as const };
      }
      if (!constantTimeEqual(codeDigest(verification.id, code), verification.code_digest)) {
        await trx
          .updateTable('email_verifications')
          .set({ attempts: verification.attempts + 1 })
          .where('id', '=', verification.id)
          .execute();
        return { ok: false as const };
      }
      await trx
        .updateTable('email_verifications')
        .set({ consumed_at: new Date() })
        .where('id', '=', verification.id)
        .execute();
      await trx
        .updateTable('user_emails')
        .set({ verified_at: new Date() })
        .where('user_id', '=', account.id)
        .execute();
      await trx
        .updateTable('users')
        .set({ status: 'pending_credential', updated_at: new Date() })
        .where('id', '=', account.id)
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: account.id,
          action: 'account.email_verified',
          requestId: meta.requestId,
        },
        trx,
      );
      return {
        ok: true as const,
        value: await onVerified({ ...account, status: 'pending_credential' }, trx),
      };
    });
    if (!result.ok) throw new AppError('INVALID_CODE');
    return result.value;
  }

  /** Marks the account active once it has its first credential (called by the auth module). */
  async activate(userId: string, trx: Transaction<Database>, meta: RequestMeta): Promise<void> {
    const result = await trx
      .updateTable('users')
      .set({ status: 'active', updated_at: new Date() })
      .where('id', '=', userId)
      .where('status', '=', 'pending_credential')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) > 0) {
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'account.activated',
          requestId: meta.requestId,
        },
        trx,
      );
    }
  }

  async byId(userId: string, executor: Executor = this.#db): Promise<Account | null> {
    const row = await this.#select(executor).where('users.id', '=', userId).executeTakeFirst();
    return row === undefined ? null : toAccount(row);
  }

  /** Looks up an account by email address or username (login identifier). */
  async byIdentifier(identifier: string): Promise<Account | null> {
    const normalized = identifier.trim();
    const query = this.#select(this.#db);
    const row = normalized.includes('@')
      ? await query.where('user_emails.email', '=', normalized).executeTakeFirst()
      : await query.where('users.username', '=', normalized.toLowerCase()).executeTakeFirst();
    return row === undefined ? null : toAccount(row);
  }

  /**
   * Finds an active account by exact username for starting a conversation. Accounts that opted
   * out of username discovery are indistinguishable from non-existent ones.
   */
  async discoverableByUsername(username: string): Promise<{ id: string; username: string } | null> {
    const row = await this.#db
      .selectFrom('users')
      .innerJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
      .select(['users.id', 'users.username', 'privacy_settings.settings'])
      .where('users.username', '=', username.trim().toLowerCase())
      .where('users.status', '=', 'active')
      .executeTakeFirst();
    if (row === undefined) return null;
    const settings = privacySettingsSchema.safeParse(row.settings);
    const discoverable = settings.success
      ? settings.data.discoverableByUsername
      : DEFAULT_PRIVACY_SETTINGS.discoverableByUsername;
    return discoverable ? { id: row.id, username: row.username } : null;
  }

  /** Usernames for a set of user ids (unknown ids are omitted). */
  async usernames(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.#db
      .selectFrom('users')
      .select(['id', 'username'])
      .where('id', 'in', [...userIds])
      .execute();
    return new Map(rows.map((row) => [row.id, row.username]));
  }

  async byEmail(email: string): Promise<Account | null> {
    return this.#byEmail(this.#db, email);
  }

  /** When the account was created (community verification gates), or null if it does not exist. */
  async accountCreatedAt(userId: string): Promise<Date | null> {
    const row = await this.#db
      .selectFrom('users')
      .select('created_at')
      .where('id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row?.created_at ?? null;
  }

  async privacySettings(userId: string): Promise<PrivacySettings> {
    const row = await this.#db
      .selectFrom('privacy_settings')
      .select('settings')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const parsed = privacySettingsSchema.safeParse(row?.settings);
    // Stored settings are re-validated; unknown/invalid data falls back to protective defaults.
    return parsed.success ? parsed.data : DEFAULT_PRIVACY_SETTINGS;
  }

  async updatePrivacySettings(
    userId: string,
    settings: PrivacySettings,
    meta: RequestMeta,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('privacy_settings')
        .values({ user_id: userId, settings: JSON.stringify(settings) })
        .onConflict((conflict) =>
          conflict
            .column('user_id')
            .doUpdateSet({ settings: JSON.stringify(settings), updated_at: new Date() }),
        )
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'privacy.updated',
          requestId: meta.requestId,
        },
        trx,
      );
    });
  }

  async #createCode(trx: Transaction<Database>, userId: string): Promise<string> {
    // Invalidate earlier codes so only the latest one works.
    await trx
      .updateTable('email_verifications')
      .set({ consumed_at: new Date() })
      .where('user_id', '=', userId)
      .where('consumed_at', 'is', null)
      .execute();
    const id = newId();
    const code = randomDigits(6);
    await trx
      .insertInto('email_verifications')
      .values({
        id,
        user_id: userId,
        code_digest: codeDigest(id, code),
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      })
      .execute();
    return code;
  }

  #select(executor: Executor) {
    return executor
      .selectFrom('users')
      .innerJoin('user_emails', 'user_emails.user_id', 'users.id')
      .select([
        'users.id',
        'users.username',
        'users.status',
        'users.created_at',
        'user_emails.email',
      ]);
  }

  async #byEmail(executor: Executor, email: string): Promise<Account | null> {
    const row = await this.#select(executor)
      .where('user_emails.email', '=', email.trim())
      .executeTakeFirst();
    return row === undefined ? null : toAccount(row);
  }
}

function toAccount(row: {
  id: string;
  username: string;
  status: AccountStatus;
  created_at: Date;
  email: string;
}): Account {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
  };
}
