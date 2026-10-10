import { newId } from '@tessera/shared';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';
import { ipPrefix, userAgentSummary } from '../../platform/client-info.js';
import type { AdminAuthenticator, AdminPrincipal } from '../../platform/http/admin-routes.js';
import { randomToken, sha256 } from '../../platform/secrets.js';

import type { AdminDirectory } from './admins.js';
import { capabilitiesOf } from './rbac.js';

/**
 * Admin sessions (docs/admin.md §1): 8 hours absolute, 30 minutes idle, a separate cookie on a
 * separate origin. The token is random, stored as its SHA-256, and replaced when the sign-in
 * completes (no fixation). Roles are read on every request, so an expiry or revocation applies at
 * once.
 */

export interface AdminSessionPolicy {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

const TOUCH_MS = 30_000;

export class AdminSessions implements AdminAuthenticator {
  readonly #db: Kysely<Database>;
  readonly #directory: AdminDirectory;
  readonly #policy: AdminSessionPolicy;

  constructor(db: Kysely<Database>, directory: AdminDirectory, policy: AdminSessionPolicy) {
    this.#db = db;
    this.#directory = directory;
    this.#policy = policy;
  }

  async create(
    adminId: string,
    client: { ip: string; userAgent: string | undefined },
  ): Promise<{ id: string; token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const id = newId();
    const expiresAt = new Date(Date.now() + this.#policy.absoluteMs);
    await this.#db
      .insertInto('admin_sessions')
      .values({
        id,
        admin_id: adminId,
        token_digest: sha256(token),
        stage: 'key',
        expires_at: expiresAt,
        ip_prefix: ipPrefix(client.ip),
        user_agent_summary: userAgentSummary(client.userAgent),
      })
      .execute();
    return { id, token, expiresAt };
  }

  async authenticate(token: string): Promise<AdminPrincipal | null> {
    const row = await this.#db
      .selectFrom('admin_sessions')
      .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.admin_id')
      .select([
        'admin_sessions.id',
        'admin_sessions.admin_id',
        'admin_sessions.stage',
        'admin_sessions.last_seen_at',
        'admin_sessions.expires_at',
        'admin_sessions.reauthenticated_at',
        'admin_users.status',
      ])
      .where('admin_sessions.token_digest', '=', sha256(token))
      .where('admin_sessions.revoked_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const now = Date.now();
    if (
      row.status !== 'active' ||
      row.expires_at.getTime() <= now ||
      now - row.last_seen_at.getTime() > this.#policy.idleMs
    ) {
      await this.revoke(row.id, 'expired');
      return null;
    }
    if (now - row.last_seen_at.getTime() > TOUCH_MS)
      await this.#db
        .updateTable('admin_sessions')
        .set({ last_seen_at: new Date(now) })
        .where('id', '=', row.id)
        .execute();
    // A half-signed-in session has no roles: it can only finish signing in.
    const roles =
      row.stage === 'active' ? (await this.#directory.roles(row.admin_id)).map((r) => r.role) : [];
    return {
      sessionId: row.id,
      adminId: row.admin_id,
      stage: row.stage,
      roles,
      capabilities: capabilitiesOf(roles),
      reauthenticatedAt: row.reauthenticated_at,
    };
  }

  /** Security key done: a new token for the full session (the old one stops working). */
  async activate(sessionId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const row = await this.#db
      .updateTable('admin_sessions')
      .set({
        token_digest: sha256(token),
        stage: 'active',
        reauthenticated_at: new Date(),
        last_seen_at: new Date(),
      })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .returning('expires_at')
      .executeTakeFirstOrThrow();
    return { token, expiresAt: row.expires_at };
  }

  async markReauthenticated(sessionId: string): Promise<void> {
    await this.#db
      .updateTable('admin_sessions')
      .set({ reauthenticated_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
  }

  async revoke(sessionId: string, _reason: string): Promise<void> {
    await this.#db
      .updateTable('admin_sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async revokeAll(adminId: string): Promise<number> {
    const result = await this.#db
      .updateTable('admin_sessions')
      .set({ revoked_at: new Date() })
      .where('admin_id', '=', adminId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
