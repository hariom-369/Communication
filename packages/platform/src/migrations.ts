import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { HealthCheck } from './health.js';
import type { Logger } from './logger.js';
import type pg from 'pg';

/**
 * Forward-only SQL migrations (docs/database.md §7).
 *
 * - Files are named `NNNN_description.sql` and applied in order, each in its own transaction
 *   unless its first line is `-- migrate:no-transaction` (needed for CREATE INDEX CONCURRENTLY).
 * - Applied migrations are recorded with a SHA-256 checksum; editing an applied file is detected
 *   and aborts the run, because the database would no longer match the source of truth.
 * - A session-level advisory lock serialises concurrent runners (e.g. two deploy jobs).
 */

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const NO_TRANSACTION = '-- migrate:no-transaction';
/** Arbitrary constant identifying the migration lock ("tessera" in ASCII, truncated). */
const LOCK_KEY = 0x7465737365;

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
  readonly transactional: boolean;
}

export class MigrationError extends Error {
  readonly safeToLog = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const seenNumbers = new Set<string>();
  const migrations: Migration[] = [];
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name);
    if (match?.[1] === undefined) throw new MigrationError(`Invalid migration file name: ${name}`);
    if (seenNumbers.has(match[1])) throw new MigrationError(`Duplicate migration number: ${name}`);
    seenNumbers.add(match[1]);
    const sql = await readFile(path.join(directory, name), 'utf8');
    migrations.push({
      version: name.slice(0, -'.sql'.length),
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      transactional: !sql.startsWith(NO_TRANSACTION),
    });
  }
  return migrations;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

async function appliedMigrations(client: pg.PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

function verifyIntegrity(migrations: readonly Migration[], applied: Map<string, string>): void {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const latestKnown = migrations.at(-1)?.version ?? '';
  for (const [version, checksum] of applied) {
    const migration = known.get(version);
    if (migration === undefined) {
      // Migrations newer than this build were applied by a newer release; running an older build
      // (e.g. during rollback) is safe because migrations are expand-only.
      if (version > latestKnown) continue;
      throw new MigrationError(`Applied migration ${version} is missing from the source tree`);
    }
    if (migration.checksum !== checksum) {
      throw new MigrationError(`Applied migration ${version} was modified after being applied`);
    }
  }
}

export async function migrate(
  pool: pg.Pool,
  migrations: readonly Migration[],
  logger: Logger,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(CREATE_TABLE);
    const applied = await appliedMigrations(client);
    verifyIntegrity(migrations, applied);

    const newlyApplied: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      logger.info('migration.apply_started', { migration: migration.version });
      if (migration.transactional) {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await recordApplied(client, migration);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } else {
        await client.query(migration.sql);
        await recordApplied(client, migration);
      }
      newlyApplied.push(migration.version);
      logger.info('migration.applied', { migration: migration.version });
    }
    return newlyApplied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function recordApplied(client: pg.PoolClient, migration: Migration): Promise<void> {
  await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
    migration.version,
    migration.checksum,
  ]);
}

/**
 * Readiness check: the database schema must include every migration this build ships with
 * (migrations run as a pre-deploy job, docs/deployment.md §3). Extra applied migrations are fine
 * — they belong to a newer version during a rolling deploy (expand/contract).
 */
export function migrationsHealthCheck(
  pool: pg.Pool,
  migrations: readonly Migration[],
): HealthCheck {
  return {
    name: 'migrations',
    check: async (signal) => {
      const client = await pool.connect();
      try {
        signal.throwIfAborted();
        const exists = await client.query<{ present: boolean }>(
          "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
        );
        if (exists.rows[0]?.present !== true) throw new MigrationError('Schema not migrated');
        const applied = await appliedMigrations(client);
        const missing = migrations.filter((migration) => !applied.has(migration.version));
        if (missing.length > 0) throw new MigrationError('Pending migrations');
      } finally {
        client.release();
      }
    },
  };
}
