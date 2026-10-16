import {
  createHealthServer,
  createLifecycle,
  createLogger,
  createMetricsRegistry,
  jobMetrics,
} from '@tessera/platform';

import { buildApp } from './app.js';
import { composeModules } from './compose.js';
import { ModerationKey } from './modules/moderation/index.js';
import { loadApiConfig } from './config.js';
import { MIGRATIONS_DIR } from './paths.js';
import { createDatabase, databaseHealthCheck } from './platform/db.js';
import { SmtpMailer } from './platform/email.js';
import { loadMigrations, migrationsHealthCheck } from '@tessera/platform';
import { S3ObjectStore } from './platform/object-store.js';
import { startSingletonTask } from './platform/periodic.js';
import {
  InProcessRateLimiter,
  ResilientRateLimiter,
  ValkeyRateLimiter,
} from './platform/rate-limit.js';
import { apiMetrics } from './platform/service-metrics.js';
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
  const registry = createMetricsRegistry('api');
  const metrics = apiMetrics(registry);
  const jobs = jobMetrics(registry);

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
      metrics.rateLimitStoreErrors.inc();
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
  const moderationKey =
    config.MODERATION_HPKE_PUBLIC_KEY !== undefined &&
    config.MODERATION_HPKE_PRIVATE_KEY !== undefined
      ? await ModerationKey.load(
          config.MODERATION_HPKE_PUBLIC_KEY,
          config.MODERATION_HPKE_PRIVATE_KEY,
        )
      : null;
  const modules = composeModules(config, {
    db: database.db,
    valkey,
    mailer,
    logger,
    media,
    moderationKey,
    metrics,
  });

  const sweeper = startSingletonTask({
    name: 'mailbox_sweeper',
    lockKey: 0x6d61696c, // "mail"
    intervalMs: 5 * 60_000,
    pool: database.pool,
    logger,
    metrics: jobs,
    task: async () => {
      await modules.messaging.sweep();
      await modules.keys.sweep();
      await modules.media.sweep();
    },
  });
  lifecycle.onShutdown({ name: 'mailbox_sweeper', run: () => sweeper.stop() });

  // Channels: scheduled posts and ownership transfers (exactly-once via compare-and-set), and
  // the roll-up of daily view counts every five minutes.
  let lastRollUp = 0;
  const channelScheduler = startSingletonTask({
    name: 'channel_scheduler',
    lockKey: 0x6368616e, // "chan"
    intervalMs: config.CHANNEL_SCHEDULER_INTERVAL_MS,
    pool: database.pool,
    logger,
    metrics: jobs,
    task: async () => {
      await modules.channels.runDue();
      if (Date.now() - lastRollUp >= 5 * 60_000) {
        lastRollUp = Date.now();
        await modules.channels.rollUpViews();
      }
    },
  });
  lifecycle.onShutdown({ name: 'channel_scheduler', run: () => channelScheduler.stop() });

  // Calls: stop unanswered ringing, drop silent or removed participants, delete old records.
  const callSweeper = startSingletonTask({
    name: 'call_sweeper',
    lockKey: 0x63616c6c, // "call"
    intervalMs: config.CALL_SWEEP_INTERVAL_MS,
    pool: database.pool,
    logger,
    metrics: jobs,
    task: async () => {
      await modules.calls.sweep();
    },
  });
  lifecycle.onShutdown({ name: 'call_sweeper', run: () => callSweeper.stop() });

  // Notifications: deliver due (coalesced) pushes and channel fan-out batches.
  const notifyWorker = startSingletonTask({
    name: 'notify_worker',
    lockKey: 0x6e6f7466, // "notf"
    intervalMs: config.NOTIFY_INTERVAL_MS,
    pool: database.pool,
    logger,
    metrics: jobs,
    task: async () => {
      // Keep going while full batches come back, so a burst drains without waiting a tick each.
      for (let round = 0; round < 10; round += 1) {
        if ((await modules.notifications.drain()) < 200) break;
      }
      metrics.notifyQueueAge.set(await modules.notifications.oldestDueSeconds());
    },
  });
  lifecycle.onShutdown({ name: 'notify_worker', run: () => notifyWorker.stop() });
  const notifySweeper = startSingletonTask({
    name: 'notify_sweeper',
    lockKey: 0x6e6f7377, // "nosw"
    intervalMs: 3_600_000,
    pool: database.pool,
    logger,
    metrics: jobs,
    task: async () => {
      await modules.notifications.sweep();
    },
  });
  lifecycle.onShutdown({ name: 'notify_sweeper', run: () => notifySweeper.stop() });

  // Moderation: record service-level breaches (and alert), delete evidence past retention.
  const moderationSweeper = startSingletonTask({
    name: 'moderation_sweeper',
    lockKey: 0x6d6f6472, // "modr"
    intervalMs: config.MODERATION_SWEEP_INTERVAL_MS,
    pool: database.pool,
    logger,
    metrics: jobs,
    task: async () => {
      await modules.moderation.sweep();
    },
  });
  lifecycle.onShutdown({ name: 'moderation_sweeper', run: () => moderationSweeper.stop() });

  const app = await buildApp({
    logger,
    rateLimiter,
    allowedOrigins: config.ALLOWED_ORIGINS,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    bodyLimitBytes: config.BODY_LIMIT_BYTES,
    hsts: config.NODE_ENV === 'production',
    routes: modules.routes,
    sessions: modules.sessions,
    standing: modules.moderation,
    ipFloodLimitPerMinute: config.IP_FLOOD_LIMIT_PER_MINUTE,
    metrics: registry,
  });
  lifecycle.onShutdown({ name: 'http', run: () => app.close() });

  await health.listen({ host: config.HOST, port: config.HEALTH_PORT });
  await app.listen({ host: config.HOST, port: config.PORT, backlog: config.LISTEN_BACKLOG });
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
