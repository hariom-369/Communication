import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLogger } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR } from '../paths.js';
import { withTemporaryDatabase } from '../test/database.js';

import { loadMigrations, migrate, MigrationError, migrationsHealthCheck } from './migrations.js';

const logger = createLogger({
  service: 'test',
  level: 'fatal',
  errorDetails: false,
  destination: new MemoryDestination(),
});

const tempDirs: string[] = [];
async function migrationDir(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'tessera-migrations-'));
  tempDirs.push(directory);
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql);
  return directory;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const signal = new AbortController().signal;

describe('migrations (real PostgreSQL)', () => {
  it('applies the shipped migrations once and is idempotent', async () => {
    await withTemporaryDatabase(async (pool) => {
      const migrations = await loadMigrations(MIGRATIONS_DIR);
      expect(migrations.length).toBeGreaterThan(0);
      const health = migrationsHealthCheck(pool, migrations);
      await expect(health.check(signal)).rejects.toBeInstanceOf(MigrationError);

      expect(await migrate(pool, migrations, logger)).toEqual(migrations.map((m) => m.version));
      expect(await migrate(pool, migrations, logger)).toEqual([]);
      await expect(health.check(signal)).resolves.toBeUndefined();

      const extensions = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm') ORDER BY extname",
      );
      expect(extensions.rows.map((row) => row.extname)).toEqual(['citext', 'pg_trgm']);
    });
  });

  it('rolls back a failing migration completely', async () => {
    const directory = await migrationDir({
      '0001_ok.sql': 'CREATE TABLE a (id int);',
      '0002_broken.sql': 'CREATE TABLE b (id int); SELECT * FROM missing_table;',
    });
    await withTemporaryDatabase(async (pool) => {
      await expect(migrate(pool, await loadMigrations(directory), logger)).rejects.toThrow();
      const tables = await pool.query<{ name: string | null }>(
        "SELECT to_regclass('public.a')::text AS name UNION ALL SELECT to_regclass('public.b')::text",
      );
      expect(tables.rows.map((row) => row.name)).toEqual(['a', null]);
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      expect(applied.rows.map((row) => row.version)).toEqual(['0001_ok']);
    });
  });

  it('refuses to run when an applied migration was edited', async () => {
    const directory = await migrationDir({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    await withTemporaryDatabase(async (pool) => {
      await migrate(pool, await loadMigrations(directory), logger);
      await writeFile(path.join(directory, '0001_a.sql'), 'CREATE TABLE a (id bigint);');
      await expect(migrate(pool, await loadMigrations(directory), logger)).rejects.toThrow(
        /modified after being applied/,
      );
    });
  });

  it('tolerates migrations applied by a newer release (rollback) but not gaps', async () => {
    const newer = await migrationDir({ '0001_a.sql': 'SELECT 1;', '0002_b.sql': 'SELECT 2;' });
    const older = await migrationDir({ '0001_a.sql': 'SELECT 1;' });
    const gap = await migrationDir({ '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 3;' });
    await withTemporaryDatabase(async (pool) => {
      await migrate(pool, await loadMigrations(newer), logger);
      await expect(migrate(pool, await loadMigrations(older), logger)).resolves.toEqual([]);
      await expect(migrate(pool, await loadMigrations(gap), logger)).rejects.toThrow(
        /missing from the source tree/,
      );
    });
  });

  it('serialises concurrent runners with an advisory lock', async () => {
    const directory = await migrationDir({
      '0001_slow.sql': 'SELECT pg_sleep(0.3); CREATE TABLE once (id int);',
    });
    await withTemporaryDatabase(async (pool) => {
      const migrations = await loadMigrations(directory);
      const results = await Promise.all([
        migrate(pool, migrations, logger),
        migrate(pool, migrations, logger),
      ]);
      expect(results.flat()).toEqual(['0001_slow']);
    });
  });

  it('supports non-transactional migrations for concurrent index builds', async () => {
    const directory = await migrationDir({
      '0001_table.sql': 'CREATE TABLE t (id int);',
      '0002_index.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY t_id_idx ON t (id);',
    });
    await withTemporaryDatabase(async (pool) => {
      await migrate(pool, await loadMigrations(directory), logger);
      const index = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 't_id_idx'");
      expect(index.rowCount).toBe(1);
    });
  });

  it('rejects badly named files', async () => {
    const directory = await migrationDir({ 'add_users.sql': 'SELECT 1;' });
    await expect(loadMigrations(directory)).rejects.toBeInstanceOf(MigrationError);
  });
});
