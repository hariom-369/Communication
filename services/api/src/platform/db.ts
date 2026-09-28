import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { HealthCheck } from '@tessera/platform';

import type { Database } from '../db/schema.js';

export type { Database } from '../db/schema.js';

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export interface DatabaseHandle {
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    // Kysely's destroy() ends the underlying pool.
    close: () => db.destroy(),
  };
}

export function databaseHealthCheck(pool: pg.Pool): HealthCheck {
  return {
    name: 'postgres',
    check: async (signal) => {
      const client = await pool.connect();
      try {
        signal.throwIfAborted();
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    },
  };
}
