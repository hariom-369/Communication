import { describe, expect, it } from 'vitest';

import { requireEnv } from '../test/integration-env.js';

import { createDatabase, databaseHealthCheck } from './db.js';

describe('database (real PostgreSQL)', () => {
  it('applies the statement timeout to every pooled connection', async () => {
    const handle = createDatabase({
      connectionString: requireEnv('TEST_DATABASE_URL'),
      poolMax: 2,
      statementTimeoutMs: 100,
      applicationName: 'tessera-it',
    });
    try {
      await expect(
        databaseHealthCheck(handle.pool).check(new AbortController().signal),
      ).resolves.toBeUndefined();
      await expect(handle.pool.query('SELECT pg_sleep(1)')).rejects.toThrow(/statement timeout/);
      const name = await handle.pool.query<{ application_name: string }>('SHOW application_name');
      expect(name.rows[0]?.application_name).toBe('tessera-it');
    } finally {
      await handle.close();
    }
  });
});
