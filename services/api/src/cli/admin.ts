import { createLogger } from '@tessera/platform';
import { loadApiConfig } from '../config.js';
import { AuditLog } from '../modules/audit/index.js';
import { createDatabase } from '../platform/db.js';

import { runAdminCommand } from './admin-command.js';

/** Break-glass operator command for admin accounts (see ./admin-command.ts). */
async function main(): Promise<number> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({
    service: 'api-admin-command',
    level: config.LOG_LEVEL,
    errorDetails: config.LOG_ERROR_DETAILS,
  });
  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: 1,
    statementTimeoutMs: 30_000,
    applicationName: 'tessera-admin-command',
    onIdleClientError: (error) => {
      logger.warn('postgres.idle_client_error', logger.errorFields(error));
    },
  });
  const db = database.db;
  try {
    const result = await runAdminCommand(db, new AuditLog(db), process.argv.slice(2));
    (result.code === 0 ? process.stdout : process.stderr).write(`${result.output}\n`);
    return result.code;
  } catch (error) {
    logger.error('admin.command_failed', logger.errorFields(error));
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
