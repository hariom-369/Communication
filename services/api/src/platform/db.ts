import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { HealthCheck } from '@tessera/platform';

/**
 * Kysely database interface. Tables are added by the modules that own them, starting in Phase 2.
 * Modules may only query their own tables (ADR-001).
 */
export interface Database {
  schema_migrations: {
    version: string;
    checksum: string;
    applied_at: Date;
  };
}

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
