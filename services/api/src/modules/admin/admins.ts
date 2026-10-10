import { AppError } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  ELEVATED_ROLES,
  MAX_BASE_ROLE_DAYS,
  MAX_ELEVATED_HOURS,
  type AdminRole,
} from '@tessera/validation';
import type { Kysely, Selectable, Transaction } from 'kysely';

import type { AdminUsersTable, Database } from '../../db/schema.js';

type Executor = Kysely<Database> | Transaction<Database>;
export type AdminRow = Selectable<AdminUsersTable>;

const HOUR = 3_600_000;

export function isElevated(role: AdminRole): boolean {
  return (ELEVATED_ROLES as readonly string[]).includes(role);
}

/** Longest a grant of this role may last (docs/admin.md §2: elevated roles ≤ 8 h). */
export function maxGrantHours(role: AdminRole): number {
  return isElevated(role) ? MAX_ELEVATED_HOURS : MAX_BASE_ROLE_DAYS * 24;
}

/** Staff identities and their time-bound roles. */
export class AdminDirectory {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async byId(id: string, executor: Executor = this.#db): Promise<AdminRow | null> {
    return (
      (await executor
        .selectFrom('admin_users')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()) ?? null
    );
  }

  async byEmail(email: string): Promise<AdminRow | null> {
    return (
      (await this.#db
        .selectFrom('admin_users')
        .selectAll()
        .where('email', '=', email.toLowerCase())
        .executeTakeFirst()) ?? null
    );
  }

  /**
   * The admin for a verified identity-provider identity. The first sign-in binds the issuer and
   * subject to the account created for that email; afterwards only that subject matches.
   */
  async forIdentity(identity: {
    issuer: string;
    subject: string;
    email: string;
  }): Promise<AdminRow | null> {
    const bound = await this.#db
      .selectFrom('admin_users')
      .selectAll()
      .where('oidc_issuer', '=', identity.issuer)
      .where('oidc_subject', '=', identity.subject)
      .executeTakeFirst();
    if (bound !== undefined) return bound.status === 'active' ? bound : null;
    const byEmail = await this.byEmail(identity.email);
    if (byEmail?.status !== 'active' || byEmail.oidc_subject !== null) return null;
    return this.#db
      .updateTable('admin_users')
      .set({ oidc_issuer: identity.issuer, oidc_subject: identity.subject })
      .where('id', '=', byEmail.id)
      .where('oidc_subject', 'is', null)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async create(
    input: { email: string; displayName: string; createdBy: string },
    executor: Executor = this.#db,
  ): Promise<AdminRow> {
    try {
      return await executor
        .insertInto('admin_users')
        .values({
          id: newId(),
          email: input.email.toLowerCase(),
          display_name: input.displayName,
          status: 'active',
          created_by: input.createdBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('CONFLICT', { detail: 'An admin with this email exists.' });
      throw error;
    }
  }

  async list(): Promise<AdminRow[]> {
    return this.#db.selectFrom('admin_users').selectAll().orderBy('email').execute();
  }

  async setEligibility(adminId: string, roles: AdminRole[], executor: Executor): Promise<void> {
    await executor
      .updateTable('admin_users')
      .set({ eligible_roles: roles.filter(isElevated) })
      .where('id', '=', adminId)
      .execute();
  }

  async disable(adminId: string, executor: Executor = this.#db): Promise<boolean> {
    const result = await executor
      .updateTable('admin_users')
      .set({ status: 'disabled', disabled_at: new Date() })
      .where('id', '=', adminId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    await executor
      .updateTable('admin_role_grants')
      .set({ revoked_at: new Date() })
      .where('admin_id', '=', adminId)
      .where('revoked_at', 'is', null)
      .execute();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Current roles (started, not expired, not revoked) with their expiry. */
  async roles(
    adminId: string,
    executor: Executor = this.#db,
  ): Promise<{ role: AdminRole; expiresAt: Date }[]> {
    const now = new Date();
    const rows = await executor
      .selectFrom('admin_role_grants')
      .select(['role', 'expires_at'])
      .where('admin_id', '=', adminId)
      .where('revoked_at', 'is', null)
      .where('starts_at', '<=', now)
      .where('expires_at', '>', now)
      .orderBy('expires_at', 'desc')
      .execute();
    const latest = new Map<AdminRole, Date>();
    for (const row of rows) if (!latest.has(row.role)) latest.set(row.role, row.expires_at);
    return [...latest].map(([role, expiresAt]) => ({ role, expiresAt }));
  }

  async grant(
    input: {
      adminId: string;
      role: AdminRole;
      hours: number;
      grantedBy: string;
      approvalId: string | null;
    },
    executor: Executor = this.#db,
  ): Promise<Date> {
    if (input.hours < 1 || input.hours > maxGrantHours(input.role))
      throw new AppError('VALIDATION_FAILED', {
        detail: isElevated(input.role)
          ? `Elevated roles last at most ${MAX_ELEVATED_HOURS} hours.`
          : `Roles last at most ${MAX_BASE_ROLE_DAYS} days.`,
      });
    const admin = await this.byId(input.adminId, executor);
    if (admin?.status !== 'active') throw new AppError('NOT_FOUND');
    const expiresAt = new Date(Date.now() + input.hours * HOUR);
    await executor
      .insertInto('admin_role_grants')
      .values({
        id: newId(),
        admin_id: input.adminId,
        role: input.role,
        expires_at: expiresAt,
        approval_id: input.approvalId,
        granted_by: input.grantedBy,
      })
      .execute();
    return expiresAt;
  }
}
