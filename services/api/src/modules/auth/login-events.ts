import { newId } from '@tessera/shared';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';
import { ipPrefix, userAgentSummary } from '../../platform/client-info.js';

import type { ClientInfo } from './sessions.js';

/** How far back a network/browser combination counts as "seen before" for sign-in alerts. */
const FAMILIAR_WINDOW_DAYS = 90;

export type LoginMethod = 'password' | 'passkey' | 'mfa' | 'recovery_code';

export class LoginEvents {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async failure(
    userId: string | null,
    method: LoginMethod,
    client: ClientInfo,
    mfa = false,
  ): Promise<void> {
    await this.#insert(userId, mfa ? 'mfa_failure' : 'failure', method, client);
  }

  /**
   * Records a successful sign-in and reports whether it came from an unfamiliar network+browser
   * combination for an account that has signed in before (→ security alert email).
   */
  async success(
    userId: string,
    method: LoginMethod,
    client: ClientInfo,
  ): Promise<{ unfamiliar: boolean }> {
    const prefix = ipPrefix(client.ip);
    const agent = userAgentSummary(client.userAgent);
    const history = await this.#db
      .selectFrom('login_events')
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) FILTER (WHERE ip_prefix = ${prefix} AND user_agent_summary = ${agent})`.as(
          'familiar',
        ),
      ])
      .where('user_id', '=', userId)
      .where('kind', '=', 'success')
      .where('created_at', '>', sql<Date>`now() - make_interval(days => ${FAMILIAR_WINDOW_DAYS})`)
      .executeTakeFirstOrThrow();
    await this.#insert(userId, 'success', method, client);
    return { unfamiliar: Number(history.total) > 0 && Number(history.familiar) === 0 };
  }

  /** A person's recent sign-in attempts (admin console, purpose-bound). */
  async recent(
    userId: string,
    limit = 50,
  ): Promise<
    { kind: string; method: string; ipPrefix: string; userAgent: string; createdAt: Date }[]
  > {
    const rows = await this.#db
      .selectFrom('login_events')
      .select(['kind', 'method', 'ip_prefix', 'user_agent_summary', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      kind: row.kind,
      method: row.method,
      ipPrefix: row.ip_prefix,
      userAgent: row.user_agent_summary,
      createdAt: row.created_at,
    }));
  }

  /** Networks with the most failed sign-ins since `since` (credential-stuffing hot spots). */
  async failureHotspots(
    since: Date,
    limit = 20,
  ): Promise<{ ipPrefix: string; failures: number; accounts: number }[]> {
    const rows = await this.#db
      .selectFrom('login_events')
      .select([
        'ip_prefix',
        sql<string>`count(*)`.as('failures'),
        sql<string>`count(DISTINCT user_id)`.as('accounts'),
      ])
      .where('kind', 'in', ['failure', 'mfa_failure'])
      .where('created_at', '>', since)
      .groupBy('ip_prefix')
      .orderBy(sql`count(*)`, 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      ipPrefix: row.ip_prefix,
      failures: Number(row.failures),
      accounts: Number(row.accounts),
    }));
  }

  async #insert(
    userId: string | null,
    kind: 'success' | 'failure' | 'mfa_failure',
    method: LoginMethod,
    client: ClientInfo,
  ): Promise<void> {
    await this.#db
      .insertInto('login_events')
      .values({
        id: newId(),
        user_id: userId,
        kind,
        method,
        ip_prefix: ipPrefix(client.ip),
        user_agent_summary: userAgentSummary(client.userAgent),
      })
      .execute();
  }
}
