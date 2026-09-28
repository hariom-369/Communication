import { createLogger } from '@tessera/platform';

import { loadApiConfig } from '../config.js';
import { MIGRATIONS_DIR } from '../paths.js';
import { createDatabase } from '../platform/db.js';
import { loadMigrations, migrate } from '@tessera/platform';

/** Pre-deploy migration job entry point (docs/deployment.md §3). */
async function main(): Promise<number> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({
    service: 'api-migrate',
    level: config.LOG_LEVEL,
    errorDetails: config.LOG_ERROR_DETAILS,
  });
  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: 1,
    // DDL can legitimately take longer than API queries; lock waits are still bounded.
    statementTimeoutMs: 15 * 60_000,
    applicationName: 'tessera-migrate',
    onIdleClientError: (error) => {
      logger.warn('postgres.idle_client_error', logger.errorFields(error));
    },
  });
  try {
    const applied = await migrate(database.pool, await loadMigrations(MIGRATIONS_DIR), logger);
    logger.info('migration.run_complete', { count: applied.length });
    return 0;
  } catch (error) {
    logger.error('migration.run_failed', logger.errorFields(error));
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
