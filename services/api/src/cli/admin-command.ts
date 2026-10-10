import { ADMIN_ROLES, ELEVATED_ROLES, type AdminRole } from '@tessera/validation';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { AdminDirectory, isElevated, maxGrantHours } from '../modules/admin/index.js';
import type { AuditLog } from '../modules/audit/index.js';

/**
 * Break-glass operator command for the admin console (docs/admin.md §2): bootstraps the first
 * admins and grants roles when no second admin can approve. Everything else goes through the
 * console's four-eyes approvals. Every use is audited; elevated roles still last at most 8 hours.
 *
 *   create <email> <display name> --by <operator>
 *   grant <email> <role> --hours <n> --by <operator>
 *   eligible <email> <role,role|none> --by <operator>
 *   disable <email> --by <operator>
 *   list
 */

const USAGE =
  'usage: admin create <email> <name> --by <op> | grant <email> <role> --hours <n> --by <op> | eligible <email> <roles|none> --by <op> | disable <email> --by <op> | list';

export interface AdminCommandResult {
  readonly code: number;
  readonly output: string;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function positional(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i] ?? '';
    if (value.startsWith('--')) i += 1;
    else result.push(value);
  }
  return result;
}

const isRole = (value: string): value is AdminRole =>
  (ADMIN_ROLES as readonly string[]).includes(value);

export async function runAdminCommand(
  db: Kysely<Database>,
  audit: AuditLog,
  args: readonly string[],
): Promise<AdminCommandResult> {
  const directory = new AdminDirectory(db);
  const [command, email, ...rest] = positional(args);
  if (command === 'list') {
    const admins = await directory.list();
    const lines = await Promise.all(
      admins.map(async (admin) => {
        const roles = (await directory.roles(admin.id))
          .map((r) => `${r.role} until ${r.expiresAt.toISOString()}`)
          .join(', ');
        return `${admin.email}\t${admin.status}\t${roles === '' ? 'no roles' : roles}\teligible: ${admin.eligible_roles.join(',') || '-'}`;
      }),
    );
    return { code: 0, output: lines.length === 0 ? 'No admins.' : lines.join('\n') };
  }
  const by = flag(args, 'by')?.trim();
  if (command === undefined || email === undefined) return { code: 2, output: USAGE };
  if (by === undefined || by === '' || by.length > 200)
    return { code: 2, output: 'Give the operator with --by (who is making this change).' };
  const record = (action: string, targetId: string, details: Record<string, string | number>) =>
    audit.record({
      actorKind: 'system',
      actorId: null,
      action,
      targetKind: 'admin',
      targetId,
      details: { ...details, by, via: 'operator_command' },
    });

  if (command === 'create') {
    const name = rest.join(' ').trim();
    if (name === '' || !email.includes('@')) return { code: 2, output: USAGE };
    const created = await directory.create({
      email,
      displayName: name,
      createdBy: `operator:${by}`,
    });
    await record('admin.operator_create', created.id, {});
    return {
      code: 0,
      output: `Created admin ${created.email}. They sign in with the identity provider and register a security key.`,
    };
  }
  const admin = await directory.byEmail(email);
  if (admin === null) return { code: 1, output: `No admin ${email}.` };

  if (command === 'grant') {
    const role = rest[0] ?? '';
    const hours = Number(flag(args, 'hours'));
    if (!isRole(role)) return { code: 2, output: `Role must be one of ${ADMIN_ROLES.join(', ')}.` };
    if (!Number.isInteger(hours) || hours < 1 || hours > maxGrantHours(role))
      return {
        code: 2,
        output: `Give --hours between 1 and ${String(maxGrantHours(role))} for ${role}${isElevated(role) ? ' (elevated roles last at most 8 hours)' : ''}.`,
      };
    const expiresAt = await directory.grant({
      adminId: admin.id,
      role,
      hours,
      grantedBy: `operator:${by}`,
      approvalId: null,
    });
    await record('admin.operator_grant', admin.id, { role, hours });
    return {
      code: 0,
      output: `Granted ${role} to ${admin.email} until ${expiresAt.toISOString()}.`,
    };
  }
  if (command === 'eligible') {
    const list = (rest[0] ?? '').split(',').filter((r) => r !== '' && r !== 'none');
    if (!list.every((r) => (ELEVATED_ROLES as readonly string[]).includes(r)))
      return { code: 2, output: `Eligibility is for ${ELEVATED_ROLES.join(', ')} (or none).` };
    await directory.setEligibility(admin.id, list as AdminRole[], db);
    await record('admin.operator_eligibility', admin.id, { roles: list.join(',') || 'none' });
    return { code: 0, output: `${admin.email} may now request: ${list.join(', ') || 'nothing'}.` };
  }
  if (command === 'disable') {
    await directory.disable(admin.id);
    await db
      .updateTable('admin_sessions')
      .set({ revoked_at: new Date() })
      .where('admin_id', '=', admin.id)
      .where('revoked_at', 'is', null)
      .execute();
    await record('admin.operator_disable', admin.id, {});
    return { code: 0, output: `Disabled ${admin.email}; their roles and sessions ended.` };
  }
  return { code: 2, output: USAGE };
}
