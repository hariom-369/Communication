import { createLogger } from '@tessera/platform';

import { loadMigrateConfig } from '../migrate-config.js';
import { AuditLog } from '../modules/audit/index.js';
import { createDatabase } from '../platform/db.js';

/**
 * Recomputes the audit log's hash chain (docs/security.md §11) and prints one JSON line:
 * `{"ok":true,"rows":N}` or `{"ok":false,"rows":N,"brokenAt":"<seq>"}` (exit code 1). Used after
 * a restore (ops/runbooks/dr-restore.md) and by the restore drill. Needs only DATABASE_URL,
 * read-only access suffices.
 */
async function main(): Promise<number> {
  const config = loadMigrateConfig(process.env);
  const logger = createLogger({
    service: 'api-verify-audit',
    level: config.LOG_LEVEL,
    errorDetails: config.LOG_ERROR_DETAILS,
  });
  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: 1,
    statementTimeoutMs: 15 * 60_000,
    applicationName: 'tessera-verify-audit',
    onIdleClientError: (error) => {
      logger.warn('postgres.idle_client_error', logger.errorFields(error));
    },
  });
  try {
    const audit = new AuditLog(database.db);
    const [brokenAt, rows] = [await audit.verifyChain(), await audit.count()];
    process.stdout.write(
      `${JSON.stringify(brokenAt === null ? { ok: true, rows } : { ok: false, rows, brokenAt })}\n`,
    );
    return brokenAt === null ? 0 : 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
