import { readFile } from 'node:fs/promises';

import {
  createHealthServer,
  createLifecycle,
  createLogger,
  createMetricsRegistry,
  loadMigrations,
  migrationsHealthCheck,
} from '@tessera/platform';

import { buildAdminApp } from './admin-app.js';
import { composeAdmin } from './admin-compose.js';
import { composeModules } from './compose.js';
import { loadApiConfig } from './config.js';
import { MIGRATIONS_DIR } from './paths.js';
import { createDatabase, databaseHealthCheck } from './platform/db.js';
import { SmtpMailer } from './platform/email.js';
import { S3ObjectStore } from './platform/object-store.js';
import {
  InProcessRateLimiter,
  ResilientRateLimiter,
  ValkeyRateLimiter,
} from './platform/rate-limit.js';
import { createValkey, valkeyHealthCheck } from './platform/valkey.js';

/**
 * Admin console API (docs/admin.md, ADR-050): a separate process on its own port, behind the
 * identity-aware proxy, serving only `/admin/v1`. It shares the database with the user API but
 * runs no background workers.
 */
async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({
    service: 'admin-api',
    level: config.LOG_LEVEL,
    errorDetails: config.LOG_ERROR_DETAILS,
  });
  if (config.ADMIN_ORIGINS === undefined || config.ADMIN_PUBLIC_URL === undefined) {
    logger.fatal('admin.config_missing', { component: 'admin' });
    process.exitCode = 1;
    return;
  }
  const lifecycle = createLifecycle({
    logger,
    drainDelayMs: config.SHUTDOWN_DRAIN_MS,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'tessera-admin',
    onIdleClientError: (error) => {
      logger.warn('postgres.idle_client_error', logger.errorFields(error));
    },
  });
  lifecycle.onShutdown({ name: 'postgres', run: () => database.close() });
  const valkey = createValkey(config.VALKEY_URL, 'tessera-admin');
  valkey.on('error', (error) => {
    logger.warn('valkey.connection_error', logger.errorFields(error));
  });
  lifecycle.onShutdown({
    name: 'valkey',
    run: async () => {
      await valkey.quit();
    },
  });
  await valkey.connect().catch((error: unknown) => {
    logger.warn('valkey.initial_connect_failed', logger.errorFields(error));
  });
  // Admin limits fail closed when the store is down (no per-process fallback for staff tools).
  const rateLimiter = new ResilientRateLimiter(
    new ValkeyRateLimiter(valkey, `${config.VALKEY_KEY_PREFIX}:rl-admin`),
    new InProcessRateLimiter(),
    (error) => {
      logger.warn('rate_limit.store_unavailable', logger.errorFields(error));
    },
  );
  const migrations = await loadMigrations(MIGRATIONS_DIR);
  const registry = createMetricsRegistry('admin-api');
  const health = createHealthServer({
    checks: [
      databaseHealthCheck(database.pool),
      migrationsHealthCheck(database.pool, migrations),
      valkeyHealthCheck(valkey),
    ],
    state: lifecycle,
    logger,
    checkTimeoutMs: 2_000,
    metrics: registry,
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
  const media = new S3ObjectStore({
    bucket: config.MEDIA_S3_BUCKET,
    region: config.MEDIA_S3_REGION,
    endpoint: config.MEDIA_S3_ENDPOINT,
    forcePathStyle: config.MEDIA_S3_FORCE_PATH_STYLE,
    ...(config.MEDIA_S3_ACCESS_KEY_ID !== undefined &&
    config.MEDIA_S3_SECRET_ACCESS_KEY !== undefined
      ? {
          credentials: {
            accessKeyId: config.MEDIA_S3_ACCESS_KEY_ID,
            secretAccessKey: config.MEDIA_S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  const modules = composeModules(config, { db: database.db, valkey, mailer, logger, media });
  const attestationRoots =
    config.ADMIN_ATTESTATION_ROOTS_FILE === undefined
      ? []
      : ((await readFile(config.ADMIN_ATTESTATION_ROOTS_FILE, 'utf8')).match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        ) ?? []);
  if (config.ADMIN_AUTHENTICATOR_AAGUIDS.length > 0 && attestationRoots.length === 0) {
    logger.fatal('admin.config_missing', { component: 'admin', check: 'attestation_roots' });
    process.exitCode = 1;
    return;
  }
  const admin = composeAdmin(
    config,
    { db: database.db, valkey, logger, media, attestationRoots },
    modules,
  );
  const app = await buildAdminApp({
    logger,
    rateLimiter,
    allowedOrigins: config.ADMIN_ORIGINS,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    hsts: config.NODE_ENV === 'production',
    routes: admin.routes,
    sessions: admin.sessions,
    audit: modules.audit,
    metrics: registry,
  });
  lifecycle.onShutdown({ name: 'http', run: () => app.close() });
  await health.listen({ host: config.HOST, port: config.ADMIN_HEALTH_PORT });
  await app.listen({ host: config.HOST, port: config.ADMIN_PORT, backlog: config.LISTEN_BACKLOG });
  lifecycle.markStarted();
  logger.info('admin.started', { port: config.ADMIN_PORT, version: config.BUILD_VERSION });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void lifecycle.shutdown(signal).then((exitCode) => process.exit(exitCode));
    });
  }
}

await main();
