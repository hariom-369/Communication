import { createHealthServer, createLifecycle, createLogger } from '@tessera/platform';

import { buildApp } from './app.js';
import { composeModules } from './compose.js';
import { loadApiConfig } from './config.js';
import { MIGRATIONS_DIR } from './paths.js';
import { createDatabase, databaseHealthCheck } from './platform/db.js';
import { SmtpMailer } from './platform/email.js';
import { loadMigrations, migrationsHealthCheck } from '@tessera/platform';
import { startSingletonTask } from './platform/periodic.js';
import {
  InProcessRateLimiter,
  ResilientRateLimiter,
  ValkeyRateLimiter,
} from './platform/rate-limit.js';
import { createValkey, valkeyHealthCheck } from './platform/valkey.js';

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({
    service: 'api',
    level: config.LOG_LEVEL,
    errorDetails: config.LOG_ERROR_DETAILS,
  });
  const lifecycle = createLifecycle({
    logger,
    drainDelayMs: config.SHUTDOWN_DRAIN_MS,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });

  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'tessera-api',
    onIdleClientError: (error) => {
      logger.warn('postgres.idle_client_error', logger.errorFields(error));
    },
  });
  lifecycle.onShutdown({ name: 'postgres', run: () => database.close() });

  const valkey = createValkey(config.VALKEY_URL, 'tessera-api');
  valkey.on('error', (error) => {
    logger.warn('valkey.connection_error', logger.errorFields(error));
  });
  lifecycle.onShutdown({
    name: 'valkey',
    run: async () => {
      await valkey.quit();
    },
  });
  // Degraded mode is supported (docs/architecture.md §10), so a failed first connect is not fatal.
  await valkey.connect().catch((error: unknown) => {
    logger.warn('valkey.initial_connect_failed', logger.errorFields(error));
  });

  const rateLimiter = new ResilientRateLimiter(
    new ValkeyRateLimiter(valkey, `${config.VALKEY_KEY_PREFIX}:rl`),
    new InProcessRateLimiter(),
    (error) => {
      logger.warn('rate_limit.store_unavailable', logger.errorFields(error));
    },
  );

  const migrations = await loadMigrations(MIGRATIONS_DIR);
  const health = createHealthServer({
    checks: [
      databaseHealthCheck(database.pool),
      migrationsHealthCheck(database.pool, migrations),
      valkeyHealthCheck(valkey),
    ],
    state: lifecycle,
    logger,
    checkTimeoutMs: 2_000,
  });
  lifecycle.onShutdown({ name: 'health', run: () => health.close() });

  const mailer = new SmtpMailer(config.SMTP_URL, config.EMAIL_FROM);
  lifecycle.onShutdown({
    name: 'smtp',
    run: () => {
      mailer.close();
      return Promise.resolve();
    },
  });
  const modules = composeModules(config, { db: database.db, valkey, mailer, logger });

  const sweeper = startSingletonTask({
    name: 'mailbox_sweeper',
    lockKey: 0x6d61696c, // "mail"
    intervalMs: 5 * 60_000,
    pool: database.pool,
    logger,
    task: () => modules.messaging.sweep(),
  });
  lifecycle.onShutdown({ name: 'mailbox_sweeper', run: () => sweeper.stop() });

  const app = await buildApp({
    logger,
    rateLimiter,
    allowedOrigins: config.ALLOWED_ORIGINS,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    bodyLimitBytes: config.BODY_LIMIT_BYTES,
    hsts: config.NODE_ENV === 'production',
    routes: modules.routes,
    sessions: modules.sessions,
  });
  lifecycle.onShutdown({ name: 'http', run: () => app.close() });

  await health.listen({ host: config.HOST, port: config.HEALTH_PORT });
  await app.listen({ host: config.HOST, port: config.PORT });
  lifecycle.markStarted();
  logger.info('api.started', { port: config.PORT, version: config.BUILD_VERSION });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void lifecycle.shutdown(signal).then((exitCode) => process.exit(exitCode));
    });
  }
}

main().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so write a minimal JSON line.
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error && name === 'ConfigError' ? error.message : undefined;
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', event: 'api.boot_failed', errorName: name, errorMessage: message })}\n`,
  );
  process.exit(1);
});
