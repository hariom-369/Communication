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
