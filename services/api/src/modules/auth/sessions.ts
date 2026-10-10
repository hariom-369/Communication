import { newId } from '@tessera/shared';
import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import { ipPrefix, userAgentSummary } from '../../platform/client-info.js';
import type {
  AuthenticatedSession,
  SessionAuthenticator,
  SessionStage,
} from '../../platform/http/routes.js';
import { randomToken, sha256 } from '../../platform/secrets.js';

/**
 * Server-side sessions (ADR-015, docs/authentication.md §4). The cookie carries a 256-bit
 * random token; only its SHA-256 digest is stored, so a database leak does not yield usable
 * sessions. Sessions are never re-used across privilege changes: stage transitions and step-up
 * re-authentication issue a new session and revoke the old one (no session fixation).
 */

type Executor = Kysely<Database> | Transaction<Database>;

export interface SessionPolicy {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

/** Short lifetimes for intermediate stages; full lifetime only for `active`. */
const STAGE_LIFETIME_MS: Record<Exclude<SessionStage, 'active'>, number> = {
  credential_setup: 30 * 60_000,
  mfa_pending: 5 * 60_000,
};

/** Throttle for last-seen writes, so authenticated reads do not all become writes. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string | undefined;
}

export interface IssuedSession {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly userAgent: string;
  readonly ipPrefix: string;
}

export class SessionService implements SessionAuthenticator {
  readonly #db: Kysely<Database>;
  readonly #policy: SessionPolicy;
  readonly #onRevoked: (userId: string) => void;
  readonly #rotationListeners: ((from: string, to: string) => void)[] = [];

  /**
   * @param onRevoked called after sessions of a user are revoked or rotated, so long-lived
   *   connections (WebSockets) can be re-validated and closed.
   */
  constructor(
    db: Kysely<Database>,
    policy: SessionPolicy,
    onRevoked: (userId: string) => void = () => undefined,
  ) {
    this.#db = db;
    this.#policy = policy;
    this.#onRevoked = onRevoked;
  }

  async issue(
    userId: string,
    stage: SessionStage,
    client: ClientInfo,
    options: { reauthenticated: boolean; executor?: Executor },
  ): Promise<IssuedSession> {
    const now = Date.now();
    const lifetime = stage === 'active' ? this.#policy.absoluteMs : STAGE_LIFETIME_MS[stage];
    const idle = stage === 'active' ? this.#policy.idleMs : lifetime;
    const token = randomToken(32);
    const session = {
      id: newId(),
      expiresAt: new Date(now + lifetime),
    };
    await (options.executor ?? this.#db)
      .insertInto('sessions')
      .values({
        id: session.id,
        user_id: userId,
        token_digest: sha256(token),
        stage,
        idle_expires_at: new Date(Math.min(now + idle, now + lifetime)),
        expires_at: session.expiresAt,
        reauthenticated_at: options.reauthenticated ? new Date(now) : null,
        user_agent_summary: userAgentSummary(client.userAgent),
        ip_prefix: ipPrefix(client.ip),
      })
      .execute();
    return { ...session, token };
  }

  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    const now = new Date();
    const row = await this.#db
      .selectFrom('sessions')
      .select(['id', 'user_id', 'stage', 'reauthenticated_at', 'last_seen_at', 'expires_at'])
      .where('token_digest', '=', sha256(token))
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .where('idle_expires_at', '>', now)
      .executeTakeFirst();
    if (row === undefined) return null;

    if (row.stage === 'active' && now.getTime() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      await this.#db
        .updateTable('sessions')
        .set({
          last_seen_at: now,
          idle_expires_at: new Date(
            Math.min(now.getTime() + this.#policy.idleMs, row.expires_at.getTime()),
          ),
        })
        .where('id', '=', row.id)
        .execute();
    }
    return {
      id: row.id,
      userId: row.user_id,
      stage: row.stage,
      reauthenticatedAt: row.reauthenticated_at,
    };
  }

  /**
   * Listeners for session rotation (old id → new id), e.g. to keep a browser's push
   * subscription when its session is replaced on a privilege change.
   */
  onRotated(listener: (from: string, to: string) => void): void {
    this.#rotationListeners.push(listener);
  }

  /** For rotations made inside an external transaction: call after it committed. */
  notifyRotated(from: string, to: string): void {
    for (const listener of this.#rotationListeners) listener(from, to);
  }

  /** Replaces a session with a new one (new token) at `stage`, revoking the old one. */
  async rotate(
    current: AuthenticatedSession,
    stage: SessionStage,
    client: ClientInfo,
    options: { reauthenticated: boolean; executor?: Executor },
  ): Promise<IssuedSession> {
    const executor = options.executor ?? this.#db;
    await this.#revokeWhere(executor, current.userId, 'rotated', current.id);
    const keepReauth =
      !options.reauthenticated && stage === current.stage && current.reauthenticatedAt !== null;
    const issued = await this.issue(current.userId, stage, client, { ...options, executor });
    if (keepReauth) {
      await executor
        .updateTable('sessions')
        .set({ reauthenticated_at: current.reauthenticatedAt })
        .where('id', '=', issued.id)
        .execute();
    }
    if (options.executor === undefined) {
      this.#onRevoked(current.userId);
      this.notifyRotated(current.id, issued.id);
    }
    return issued;
  }

  async list(userId: string): Promise<SessionRecord[]> {
    const rows = await this.#db
      .selectFrom('sessions')
      .select(['id', 'created_at', 'last_seen_at', 'user_agent_summary', 'ip_prefix'])
      .where('user_id', '=', userId)
      .where('stage', '=', 'active')
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where('idle_expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent_summary,
      ipPrefix: row.ip_prefix,
    }));
  }

  /** The ids among `sessionIds` that are signed in (used by notifications, before every push). */
  async activeSessionIds(sessionIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return new Set();
    const now = new Date();
    const rows = await this.#db
      .selectFrom('sessions')
      .select('id')
      .where('id', 'in', ids)
      .where('stage', '=', 'active')
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .where('idle_expires_at', '>', now)
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  /** Revokes one of the user's sessions. Returns false if it does not exist or is not theirs. */
  async revoke(
    userId: string,
    sessionId: string,
    reason: string,
    executor?: Executor,
  ): Promise<boolean> {
    const result = await this.#revokeWhere(executor ?? this.#db, userId, reason, sessionId);
    if (executor === undefined && result > 0) this.#onRevoked(userId);
    return result > 0;
  }

  /**
   * Tells listeners that `userId`'s sessions changed. Methods called with an external transaction
   * do not notify (the hint would race the commit); their callers invoke this after committing.
   * Revocation is enforced on every request regardless; this only closes open WebSockets sooner.
   */
  notifyRevoked(userId: string): void {
    this.#onRevoked(userId);
  }

  /** Revokes all of the user's sessions except `exceptId` (log out everywhere else). */
  async revokeAll(
    userId: string,
    reason: string,
    options: { exceptId?: string; executor?: Executor } = {},
  ): Promise<number> {
    let query = (options.executor ?? this.#db)
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (options.exceptId !== undefined) query = query.where('id', '!=', options.exceptId);
    const result = await query.executeTakeFirst();
    if (options.executor === undefined && Number(result.numUpdatedRows) > 0)
      this.#onRevoked(userId);
    return Number(result.numUpdatedRows);
  }

  async #revokeWhere(
    executor: Executor,
    userId: string,
    reason: string,
    sessionId: string,
  ): Promise<number> {
    const result = await executor
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
