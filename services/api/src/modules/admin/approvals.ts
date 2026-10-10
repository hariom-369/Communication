import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import type { AdminRole, ApprovalPayload } from '@tessera/validation';
import type { Kysely, Selectable } from 'kysely';

import type { AdminApprovalsTable, Database } from '../../db/schema.js';

import { isElevated, maxGrantHours, type AdminDirectory } from './admins.js';

/**
 * Four eyes (docs/admin.md §2): sensitive changes are requests; a *different* admin with the
 * right role approves them, within 24 hours, before they take effect. Who may request and who
 * may approve is decided per kind here; the database also refuses self-approval.
 */

const REQUEST_TTL_MS = 24 * 3_600_000;
export type ApprovalRow = Selectable<AdminApprovalsTable>;

export interface ApprovalEffects {
  /** Feature flags (the flags module). */
  flag(key: string): Promise<{ kind: 'product' | 'security' } | null>;
  applyFlag(
    key: string,
    change: { enabled: boolean; rolloutPercent: number },
    adminId: string,
  ): Promise<void>;
  /** Moderation staff roles on user accounts (the moderation module). */
  userIdByUsername(username: string): Promise<string | null>;
  grantStaff(
    userId: string,
    role: 'moderator' | 'senior_moderator' | 'legal',
    days: number,
    grantedBy: string,
  ): Promise<void>;
}

const has = (roles: readonly AdminRole[], ...wanted: AdminRole[]) =>
  wanted.some((role) => roles.includes(role));

export class Approvals {
  readonly #db: Kysely<Database>;
  readonly #directory: AdminDirectory;
  readonly #effects: ApprovalEffects;
  readonly #logger: Logger;

  constructor(
    db: Kysely<Database>,
    directory: AdminDirectory,
    effects: ApprovalEffects,
    logger: Logger,
  ) {
    this.#db = db;
    this.#directory = directory;
    this.#effects = effects;
    this.#logger = logger;
  }

  /** Who may ask for this change. */
  async #mayRequest(
    requesterId: string,
    roles: readonly AdminRole[],
    payload: ApprovalPayload,
  ): Promise<boolean> {
    switch (payload.kind) {
      case 'role_grant': {
        if (payload.hours > maxGrantHours(payload.role)) return false;
        if (has(roles, 'super_admin')) return true;
        // Just-in-time elevation: for yourself, and only for roles you are eligible for.
        if (!isElevated(payload.role) || payload.adminId !== requesterId) return false;
        const me = await this.#directory.byId(requesterId);
        return me?.eligible_roles.includes(payload.role) === true;
      }
      case 'eligibility':
      case 'admin_create':
      case 'staff_role':
        return has(roles, 'super_admin');
      case 'feature_flag': {
        const flag = await this.#effects.flag(payload.key);
        if (flag === null) return false;
        return flag.kind === 'security'
          ? has(roles, 'super_admin', 'security_admin')
          : has(roles, 'super_admin');
      }
    }
  }

  /** Who may approve it (always someone other than the requester and the person it is about). */
  async #mayApprove(
    approverId: string,
    roles: readonly AdminRole[],
    row: ApprovalRow,
  ): Promise<boolean> {
    const payload = row.payload as unknown as ApprovalPayload;
    if (approverId === row.requested_by) return false;
    switch (payload.kind) {
      case 'role_grant':
        if (payload.adminId === approverId) return false;
        return payload.role === 'security_admin'
          ? has(roles, 'super_admin', 'security_admin')
          : has(roles, 'super_admin');
      case 'eligibility':
        return payload.adminId !== approverId && has(roles, 'super_admin');
      case 'admin_create':
        return has(roles, 'super_admin');
      case 'staff_role':
        return has(roles, 'super_admin', 'security_admin');
      case 'feature_flag': {
        const flag = await this.#effects.flag(payload.key);
        return flag?.kind === 'security'
          ? has(roles, 'super_admin', 'security_admin')
          : has(roles, 'super_admin');
      }
    }
  }

  async request(
    requesterId: string,
    roles: readonly AdminRole[],
    payload: ApprovalPayload,
    reason: string,
  ): Promise<ApprovalRow> {
    if (!(await this.#mayRequest(requesterId, roles, payload))) throw new AppError('FORBIDDEN');
    return this.#db
      .insertInto('admin_approvals')
      .values({
        id: newId(),
        kind: payload.kind,
        payload: JSON.stringify(payload),
        reason,
        requested_by: requesterId,
        expires_at: new Date(Date.now() + REQUEST_TTL_MS),
        status: 'pending',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async list(status: ApprovalRow['status']): Promise<ApprovalRow[]> {
    return this.#db
      .selectFrom('admin_approvals')
      .selectAll()
      .where('status', '=', status)
      .orderBy('requested_at', 'desc')
      .limit(200)
      .execute();
  }

  async #pending(id: string): Promise<ApprovalRow> {
    const row = await this.#db
      .selectFrom('admin_approvals')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    if (row.status !== 'pending')
      throw new AppError('CONFLICT', { detail: 'This request was already decided.' });
    if (row.expires_at.getTime() <= Date.now())
      throw new AppError('CONFLICT', { detail: 'This request expired.' });
    return row;
  }

  async approve(
    approverId: string,
    roles: readonly AdminRole[],
    id: string,
    note: string,
  ): Promise<ApprovalRow> {
    const row = await this.#pending(id);
    if (!(await this.#mayApprove(approverId, roles, row))) throw new AppError('FORBIDDEN');
    // Claim the request atomically; only one approval can take effect.
    const claimed = await this.#db
      .updateTable('admin_approvals')
      .set({
        status: 'approved',
        decided_by: approverId,
        decided_at: new Date(),
        decision_note: note,
      })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    if (claimed === undefined)
      throw new AppError('CONFLICT', { detail: 'This request was already decided.' });
    try {
      await this.#apply(claimed, approverId);
    } catch (error) {
      await this.#db
        .updateTable('admin_approvals')
        .set({ status: 'pending', decided_by: null, decided_at: null, decision_note: '' })
        .where('id', '=', id)
        .execute();
      throw error;
    }
    return claimed;
  }

  async reject(
    approverId: string,
    roles: readonly AdminRole[],
    id: string,
    note: string,
  ): Promise<void> {
    const row = await this.#pending(id);
    if (!(await this.#mayApprove(approverId, roles, row))) throw new AppError('FORBIDDEN');
    await this.#db
      .updateTable('admin_approvals')
      .set({
        status: 'rejected',
        decided_by: approverId,
        decided_at: new Date(),
        decision_note: note,
      })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .execute();
  }

  async cancel(requesterId: string, id: string): Promise<void> {
    const row = await this.#pending(id);
    if (row.requested_by !== requesterId) throw new AppError('FORBIDDEN');
    await this.#db
      .updateTable('admin_approvals')
      .set({ status: 'cancelled' })
      .where('id', '=', id)
      .execute();
  }

  async #apply(row: ApprovalRow, approverId: string): Promise<void> {
    const payload = row.payload as unknown as ApprovalPayload;
    const grantedBy = `approval:${row.id}`;
    switch (payload.kind) {
      case 'role_grant':
        await this.#directory.grant({
          adminId: payload.adminId,
          role: payload.role,
          hours: payload.hours,
          grantedBy,
          approvalId: row.id,
        });
        this.#logger.warn('admin.alert', {
          component: 'admin',
          check: `role_grant:${payload.role}`,
        });
        return;
      case 'eligibility':
        await this.#directory.setEligibility(payload.adminId, [...payload.roles], this.#db);
        this.#logger.warn('admin.alert', { component: 'admin', check: 'eligibility_change' });
        return;
      case 'admin_create':
        await this.#directory.create({
          email: payload.email,
          displayName: payload.displayName,
          createdBy: grantedBy,
        });
        return;
      case 'feature_flag':
        await this.#effects.applyFlag(
          payload.key,
          { enabled: payload.enabled, rolloutPercent: payload.rolloutPercent },
          approverId,
        );
        return;
      case 'staff_role': {
        const userId = await this.#effects.userIdByUsername(payload.username);
        if (userId === null)
          throw new AppError('NOT_FOUND', { detail: 'No account with that username.' });
        await this.#effects.grantStaff(userId, payload.role, payload.days, grantedBy);
        return;
      }
    }
  }
}
