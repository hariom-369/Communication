import { STAFF_ROLES, type StaffRole } from '@tessera/validation';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import type { AuditLog } from '../modules/audit/index.js';

/**
 * Staff roles for the moderation console (docs/moderation.md §6). Interim until the admin console
 * with the corporate identity provider (Phase 12): granted only by an operator with database
 * access, always with an expiry, and audited.
 *
 *   grant <username> <role> --days <1-90> --by <operator>
 *   revoke <username> <role> --by <operator>
 *   list
 */

const MAX_DAYS = 90;
const USAGE =
  'usage: staff grant <username> <role> --days <1-90> --by <operator> | staff revoke <username> <role> --by <operator> | staff list';

export interface StaffCommandResult {
  readonly code: number;
  readonly output: string;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function isRole(value: string | undefined): value is StaffRole {
  return value !== undefined && (STAFF_ROLES as readonly string[]).includes(value);
}

export async function runStaffCommand(
  db: Kysely<Database>,
  audit: AuditLog,
  args: readonly string[],
  now = new Date(),
): Promise<StaffCommandResult> {
  const [command, username, role] = args;
  if (command === 'list') {
    const rows = await db
      .selectFrom('staff_roles')
      .innerJoin('users', 'users.id', 'staff_roles.user_id')
      .select([
        'users.username',
        'staff_roles.role',
        'staff_roles.expires_at',
        'staff_roles.granted_by',
      ])
      .orderBy('users.username')
      .execute();
    const lines = rows.map(
      (row) =>
        `${row.username}\t${row.role}\t${row.expires_at <= now ? 'expired' : `until ${row.expires_at.toISOString()}`}\tgranted by ${row.granted_by}`,
    );
    return { code: 0, output: lines.length === 0 ? 'No staff roles.' : lines.join('\n') };
  }
  if ((command !== 'grant' && command !== 'revoke') || username === undefined || !isRole(role))
    return { code: 2, output: USAGE };
  const by = flag(args, 'by')?.trim();
  if (by === undefined || by.length === 0 || by.length > 200)
    return { code: 2, output: 'Give the operator with --by (who is making this change).' };
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', username.toLowerCase())
    .executeTakeFirst();
  if (user === undefined) return { code: 1, output: `No account @${username}.` };

  if (command === 'revoke') {
    const result = await db
      .deleteFrom('staff_roles')
      .where('user_id', '=', user.id)
      .where('role', '=', role)
      .executeTakeFirst();
    await audit.record({
      actorKind: 'system',
      actorId: null,
      action: 'moderation.staff_role_revoked',
      targetKind: 'user',
      targetId: user.id,
      details: { role, by },
    });
    return {
      code: 0,
      output:
        Number(result.numDeletedRows) === 0
          ? `@${username} did not have ${role}.`
          : `Revoked ${role} from @${username} (takes effect within 30 seconds).`,
    };
  }

  const days = Number(flag(args, 'days'));
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
    return {
      code: 2,
      output: `Give --days between 1 and ${String(MAX_DAYS)} (roles always expire).`,
    };
  const expiresAt = new Date(now.getTime() + days * 24 * 3_600_000);
  await db
    .insertInto('staff_roles')
    .values({ user_id: user.id, role, granted_by: by, granted_at: now, expires_at: expiresAt })
    .onConflict((oc) =>
      oc
        .columns(['user_id', 'role'])
        .doUpdateSet({ granted_by: by, granted_at: now, expires_at: expiresAt }),
    )
    .execute();
  await audit.record({
    actorKind: 'system',
    actorId: null,
    action: 'moderation.staff_role_granted',
    targetKind: 'user',
    targetId: user.id,
    details: { role, by, days },
  });
  return { code: 0, output: `Granted ${role} to @${username} until ${expiresAt.toISOString()}.` };
}
