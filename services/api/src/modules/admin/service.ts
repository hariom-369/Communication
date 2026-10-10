import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import type {
  AdminDashboard,
  AdminListEntry,
  AdminRole,
  AdminUserDetail,
  AdminUserSummary,
  AuditPage,
  HealthReport,
  SecurityHotspots,
  SignupAnalytics,
  StaffRoleEntry,
  Ticket,
} from '@tessera/validation';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';
import type { AdminPrincipal } from '../../platform/http/admin-routes.js';

import type { AdminDirectory } from './admins.js';

/**
 * Admin features (docs/admin.md §4). Data about a person is reached only by exact identifier and
 * only for a purpose: an open support ticket about them, an open moderation case about them, or —
 * for security staff — a written investigation reason. Admins never see message content (there is
 * none on the server), password hashes, session tokens, TOTP secrets or recovery codes.
 */

export interface AdminPorts {
  readonly accounts: {
    byId(userId: string): Promise<{
      id: string;
      username: string;
      email: string;
      status: string;
      createdAt: Date;
    } | null>;
    byIdentifier(identifier: string): Promise<{
      id: string;
      username: string;
      email: string;
      status: string;
      createdAt: Date;
    } | null>;
    usernames(userIds: readonly string[]): Promise<Map<string, string>>;
    resendVerification(email: string): Promise<void>;
    stats(): Promise<{ total: number; newLast24h: number }>;
    signupsPerDay(days: number): Promise<{ date: string; count: number }[]>;
  };
  readonly auth: {
    summary(userId: string): Promise<AdminUserDetail['credentials']>;
    sessions(
      userId: string,
    ): Promise<
      { id: string; createdAt: Date; lastSeenAt: Date; userAgent: string; ipPrefix: string }[]
    >;
    revokeSession(userId: string, sessionId: string): Promise<boolean>;
    revokeAll(userId: string): Promise<number>;
    loginEvents(
      userId: string,
    ): Promise<
      { kind: string; method: string; ipPrefix: string; userAgent: string; createdAt: Date }[]
    >;
    activeUsersSince(since: Date): Promise<number>;
    failureHotspots(
      since: Date,
    ): Promise<{ ipPrefix: string; failures: number; accounts: number }[]>;
  };
  readonly devices: {
    list(
      userId: string,
    ): Promise<{ id: string; label: string; createdAt: string; revoked: boolean }[]>;
  };
  readonly moderation: {
    standing(userId: string): Promise<{ status: string; suspendedUntil: string | null }>;
    caseConcerns(caseId: string, userId: string): Promise<boolean>;
    metrics(): Promise<{ openCases: number; missedDeadlines: number }>;
    staffList(): Promise<
      {
        userId: string;
        role: 'moderator' | 'senior_moderator' | 'legal';
        expiresAt: Date;
        grantedBy: string;
      }[]
    >;
    revokeStaff(userId: string, role: 'moderator' | 'senior_moderator' | 'legal'): Promise<boolean>;
  };
  readonly messaging: { countSince(since: Date): Promise<number> };
  readonly billing: { summary(userId: string): Promise<AdminUserDetail['billing']> };
  readonly notifications: { queueDepth(): Promise<number> };
  readonly flags: {
    list(): Promise<
      {
        key: string;
        description: string;
        kind: 'product' | 'security';
        enabled: boolean;
        rolloutPercent: number;
        updatedBy: string | null;
        updatedAt: Date;
      }[]
    >;
  };
  readonly audit: {
    page(filter: {
      action?: string | undefined;
      actorId?: string | undefined;
      targetId?: string | undefined;
      before?: number | undefined;
      limit: number;
    }): Promise<
      {
        seq: number;
        at: Date;
        actorKind: string;
        actorId: string | null;
        action: string;
        targetKind: string | null;
        targetId: string | null;
        details: Record<string, unknown>;
      }[]
    >;
    verifyChain(): Promise<string | null>;
  };
  readonly health: { name: string; check(): Promise<string> }[];
}

/** Sign-ups below this per day are not shown (k-anonymity of aggregates). */
export const ANONYMITY_THRESHOLD = 5;
const LOOKUP_ALERT = { windowSeconds: 600, limit: 20 };

type Purpose = { kind: 'ticket' | 'case'; id: string } | { kind: 'investigation'; reason: string };

export function parsePurpose(value: string): Purpose {
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  if (kind === 'ticket' || kind === 'case') return { kind, id: rest };
  if (kind === 'investigation') return { kind, reason: rest };
  throw new AppError('VALIDATION_FAILED', { detail: 'Give a purpose.' });
}

const has = (principal: AdminPrincipal, ...roles: AdminRole[]) =>
  roles.some((role) => principal.roles.includes(role));

export class AdminService {
  readonly #db: Kysely<Database>;
  readonly #valkey: Redis;
  readonly #prefix: string;
  readonly #directory: AdminDirectory;
  readonly #ports: AdminPorts;
  readonly #logger: Logger;

  constructor(deps: {
    db: Kysely<Database>;
    valkey: Redis;
    keyPrefix: string;
    directory: AdminDirectory;
    ports: AdminPorts;
    logger: Logger;
  }) {
    this.#db = deps.db;
    this.#valkey = deps.valkey;
    this.#prefix = `${deps.keyPrefix}:admin`;
    this.#directory = deps.directory;
    this.#ports = deps.ports;
    this.#logger = deps.logger;
  }

  get ports(): AdminPorts {
    return this.#ports;
  }

  // ---- purpose binding ------------------------------------------------------------------------

  /**
   * The purpose must fit both the person looking and the person looked at: support staff through
   * an open ticket about them, moderators through an open case about them, security staff (and
   * super admins) with a recorded investigation reason. Anything else looks like "not found".
   */
  async #checkPurpose(principal: AdminPrincipal, userId: string, purpose: Purpose): Promise<void> {
    let allowed = false;
    if (purpose.kind === 'ticket' && has(principal, 'support_agent', 'super_admin')) {
      const ticket = await this.#db
        .selectFrom('support_tickets')
        .select(['status', 'subject_user_id'])
        .where('id', '=', purpose.id)
        .executeTakeFirst();
      allowed = ticket?.status === 'open' && ticket.subject_user_id === userId;
    } else if (
      purpose.kind === 'case' &&
      has(principal, 'moderator', 'security_admin', 'super_admin')
    ) {
      allowed = await this.#ports.moderation.caseConcerns(purpose.id, userId);
    } else if (purpose.kind === 'investigation') {
      allowed = has(principal, 'security_admin', 'super_admin');
    }
    if (!allowed) throw new AppError('NOT_FOUND');
  }

  async #countLookup(adminId: string): Promise<void> {
    const key = `${this.#prefix}:lookups:${adminId}`;
    const count = await this.#valkey.incr(key);
    if (count === 1) await this.#valkey.expire(key, LOOKUP_ALERT.windowSeconds);
    if (count === LOOKUP_ALERT.limit + 1)
      this.#logger.warn('admin.alert', { component: 'admin', check: 'bulk_lookups', count });
  }

  async lookup(
    principal: AdminPrincipal,
    identifier: string,
    purposeText: string,
  ): Promise<AdminUserSummary> {
    const purpose = parsePurpose(purposeText);
    await this.#countLookup(principal.adminId);
    const account = /^[0-9a-f-]{36}$/.test(identifier)
      ? await this.#ports.accounts.byId(identifier)
      : await this.#ports.accounts.byIdentifier(identifier);
    if (account === null) throw new AppError('NOT_FOUND');
    await this.#checkPurpose(principal, account.id, purpose);
    return { ...account, createdAt: account.createdAt.toISOString() };
  }

  async userDetail(
    principal: AdminPrincipal,
    userId: string,
    purposeText: string,
  ): Promise<AdminUserDetail> {
    await this.#checkPurpose(principal, userId, parsePurpose(purposeText));
    await this.#countLookup(principal.adminId);
    const account = await this.#ports.accounts.byId(userId);
    if (account === null) throw new AppError('NOT_FOUND');
    const [credentials, devices, sessions, loginEvents, standing, billing] = await Promise.all([
      this.#ports.auth.summary(userId),
      this.#ports.devices.list(userId),
      this.#ports.auth.sessions(userId),
      this.#ports.auth.loginEvents(userId),
      this.#ports.moderation.standing(userId),
      this.#ports.billing.summary(userId),
    ]);
    return {
      ...account,
      createdAt: account.createdAt.toISOString(),
      credentials,
      devices,
      sessions: sessions.map((s) => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
      })),
      loginEvents: loginEvents.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      standing,
      billing,
    };
  }

  async revokeSessions(
    principal: AdminPrincipal,
    userId: string,
    purposeText: string,
    sessionId?: string,
  ): Promise<number> {
    await this.#checkPurpose(principal, userId, parsePurpose(purposeText));
    if (sessionId !== undefined) {
      if (!(await this.#ports.auth.revokeSession(userId, sessionId)))
        throw new AppError('NOT_FOUND');
      return 1;
    }
    return this.#ports.auth.revokeAll(userId);
  }

  async resendVerification(
    principal: AdminPrincipal,
    userId: string,
    purposeText: string,
  ): Promise<void> {
    await this.#checkPurpose(principal, userId, parsePurpose(purposeText));
    const account = await this.#ports.accounts.byId(userId);
    if (account === null) throw new AppError('NOT_FOUND');
    if (account.status !== 'pending_verification')
      throw new AppError('CONFLICT', { detail: 'This email address is already verified.' });
    await this.#ports.accounts.resendVerification(account.email);
  }

  // ---- support tickets ----------------------------------------------------------------------------

  async createTicket(
    principal: AdminPrincipal,
    input: { reference: string; identifier: string; reason: string },
  ): Promise<Ticket> {
    const account = await this.#ports.accounts.byIdentifier(input.identifier);
    if (account === null)
      throw new AppError('NOT_FOUND', { detail: 'No account with that email or username.' });
    const row = await this.#db
      .insertInto('support_tickets')
      .values({
        id: newId(),
        reference: input.reference,
        subject_user_id: account.id,
        reason: input.reason,
        status: 'open',
        created_by: principal.adminId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.#ticketView(row, account.username, await this.#emailOf(row.created_by));
  }

  async #emailOf(adminId: string): Promise<string> {
    return (await this.#directory.byId(adminId))?.email ?? 'unknown';
  }

  #ticketView(
    row: {
      id: string;
      reference: string;
      subject_user_id: string;
      reason: string;
      status: 'open' | 'closed';
      created_at: Date;
      closed_at: Date | null;
    },
    username: string,
    createdBy: string,
  ): Ticket {
    return {
      id: row.id,
      reference: row.reference,
      subjectUserId: row.subject_user_id,
      subjectUsername: username,
      reason: row.reason,
      status: row.status,
      createdBy,
      createdAt: row.created_at.toISOString(),
      closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    };
  }

  async tickets(status: 'open' | 'closed'): Promise<Ticket[]> {
    const rows = await this.#db
      .selectFrom('support_tickets')
      .innerJoin('admin_users', 'admin_users.id', 'support_tickets.created_by')
      .selectAll('support_tickets')
      .select('admin_users.email as created_by_email')
      .where('support_tickets.status', '=', status)
      .orderBy('support_tickets.created_at', 'desc')
      .limit(200)
      .execute();
    const names = await this.#ports.accounts.usernames(rows.map((row) => row.subject_user_id));
    return rows.map((row) =>
      this.#ticketView(row, names.get(row.subject_user_id) ?? 'deleted', row.created_by_email),
    );
  }

  async closeTicket(ticketId: string): Promise<void> {
    const result = await this.#db
      .updateTable('support_tickets')
      .set({ status: 'closed', closed_at: new Date() })
      .where('id', '=', ticketId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new AppError('NOT_FOUND');
  }

  // ---- aggregates ---------------------------------------------------------------------------------

  async dashboard(): Promise<AdminDashboard> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [users, active, messages, moderation, pending, queue] = await Promise.all([
      this.#ports.accounts.stats(),
      this.#ports.auth.activeUsersSince(since),
      this.#ports.messaging.countSince(since),
      this.#ports.moderation.metrics(),
      this.#db
        .selectFrom('admin_approvals')
        .select(sql<string>`count(*)`.as('n'))
        .where('status', '=', 'pending')
        .where('expires_at', '>', new Date())
        .executeTakeFirstOrThrow(),
      this.#ports.notifications.queueDepth(),
    ]);
    return {
      users: { ...users, activeLast24h: active },
      messagesLast24h: messages,
      moderation,
      pendingApprovals: Number(pending.n),
      notificationQueue: queue,
    };
  }

  async signups(days: number): Promise<SignupAnalytics> {
    const rows = await this.#ports.accounts.signupsPerDay(days);
    return {
      threshold: ANONYMITY_THRESHOLD,
      days: rows.map((row) => ({
        date: row.date,
        signups: row.count > 0 && row.count < ANONYMITY_THRESHOLD ? null : row.count,
      })),
    };
  }

  async health(): Promise<HealthReport> {
    const checks = await Promise.all(
      this.#ports.health.map(async (probe) => {
        const started = performance.now();
        try {
          const detail = await probe.check();
          return {
            name: probe.name,
            ok: true,
            latencyMs: Math.round(performance.now() - started),
            detail,
          };
        } catch {
          return {
            name: probe.name,
            ok: false,
            latencyMs: Math.round(performance.now() - started),
            detail: 'unreachable',
          };
        }
      }),
    );
    return { checks };
  }

  async hotspots(hours: number): Promise<SecurityHotspots> {
    const since = new Date(Date.now() - hours * 3_600_000);
    return { since: since.toISOString(), hotspots: await this.#ports.auth.failureHotspots(since) };
  }

  // ---- admins and staff -------------------------------------------------------------------------

  async admins(): Promise<AdminListEntry[]> {
    const rows = await this.#directory.list();
    const keyCounts = await this.#db
      .selectFrom('admin_credentials')
      .select(['admin_id', sql<string>`count(*)`.as('n')])
      .groupBy('admin_id')
      .execute();
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        status: row.status,
        roles: (await this.#directory.roles(row.id)).map((r) => ({
          role: r.role,
          expiresAt: r.expiresAt.toISOString(),
        })),
        eligibleRoles: row.eligible_roles.filter(
          (r): r is 'super_admin' | 'security_admin' =>
            r === 'super_admin' || r === 'security_admin',
        ),
        keys: Number(keyCounts.find((k) => k.admin_id === row.id)?.n ?? 0),
      })),
    );
  }

  async staff(): Promise<StaffRoleEntry[]> {
    const rows = await this.#ports.moderation.staffList();
    const names = await this.#ports.accounts.usernames(rows.map((row) => row.userId));
    return rows.map((row) => ({
      userId: row.userId,
      username: names.get(row.userId) ?? 'deleted',
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      grantedBy: row.grantedBy,
    }));
  }

  // ---- audit ------------------------------------------------------------------------------------

  async auditPage(
    principal: AdminPrincipal,
    filter: {
      action?: string | undefined;
      actorId?: string | undefined;
      targetId?: string | undefined;
      before?: number | undefined;
      limit: number;
    },
  ): Promise<AuditPage> {
    const all = principal.capabilities.has('auditViewAll');
    const entries = await this.#ports.audit.page(
      all ? filter : { ...filter, actorId: principal.adminId },
    );
    return {
      entries: entries.map((e) => ({ ...e, at: e.at.toISOString() })),
      chainBrokenAt: all ? await this.#ports.audit.verifyChain() : null,
      ownOnly: !all,
    };
  }
}
