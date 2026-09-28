import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { requireEnv } from './integration-env.js';

/** Creates an isolated, empty database for one test and drops it afterwards. */
export async function withTemporaryDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const adminUrl = requireEnv('TEST_DATABASE_URL');
  const name = `tessera_it_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pool.on('error', () => undefined);
  try {
    return await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}
