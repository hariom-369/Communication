import { createServer } from 'node:http';

import {
  createHealthServer,
  createLifecycle,
  createLogger,
  createMetricsRegistry,
} from '@tessera/platform';
import { Redis } from 'ioredis';
import pg from 'pg';

import { loadRealtimeConfig } from './config.js';
import { RealtimeGateway } from './gateway.js';

async function main(): Promise<void> {
  const config = loadRealtimeConfig(process.env);
  const logger = createLogger({
    service: 'realtime',
    level: config.LOG_LEVEL,
    errorDetails: config.LOG_ERROR_DETAILS,
  });
  const lifecycle = createLifecycle({
    logger,
    drainDelayMs: 0, // draining is handled by the gateway (reconnect hints)
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });

  const db = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    application_name: 'tessera-realtime',
    statement_timeout: 2000,
  });
  // Idle pooled connections can fail (restart, failover); unhandled, pg would crash the process.
  db.on('error', (error) => {
    logger.warn('postgres.idle_client_error', logger.errorFields(error));
  });
  lifecycle.onShutdown({ name: 'postgres', run: () => db.end() });
  const valkeyOptions = {
    connectionName: 'tessera-realtime',
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  };
  const valkey = new Redis(config.VALKEY_URL, valkeyOptions);
  const subscriber = new Redis(config.VALKEY_URL, {
    ...valkeyOptions,
    connectionName: 'tessera-realtime-sub',
    commandTimeout: undefined,
  });
  for (const client of [valkey, subscriber]) {
    client.on('error', (error) => {
      logger.warn('valkey.connection_error', logger.errorFields(error));
    });
  }
  lifecycle.onShutdown({
    name: 'valkey',
    run: async () => {
      await Promise.all([valkey.quit(), subscriber.quit()]);
    },
  });

  const metrics = createMetricsRegistry('realtime');
  const gateway = new RealtimeGateway({
    config: {
      allowedOrigins: config.ALLOWED_ORIGINS,
      path: config.WS_PATH,
      keyPrefix: config.VALKEY_KEY_PREFIX,
      maxConnections: config.MAX_CONNECTIONS,
      maxConnectionsPerUser: config.MAX_CONNECTIONS_PER_USER,
      heartbeatMs: config.HEARTBEAT_SECONDS * 1000,
      authTimeoutMs: config.AUTH_TIMEOUT_MS,
      sessionRecheckMs: config.SESSION_RECHECK_SECONDS * 1000,
      resyncSpreadMs: config.RESYNC_SPREAD_SECONDS * 1000,
    },
    valkey,
    subscriber,
    db,
    logger,
    metrics,
  });

  const http = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  });
  http.on('upgrade', (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head);
  });
  lifecycle.onShutdown({
    name: 'http',
    run: () =>
      new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      ),
  });
  lifecycle.onShutdown({ name: 'gateway', run: () => gateway.drain(config.SHUTDOWN_DRAIN_MS) });

  const health = createHealthServer({
    checks: [
      {
        name: 'postgres',
        check: async () => {
          await db.query('SELECT 1');
        },
      },
      {
        name: 'valkey',
        check: async () => {
          await valkey.ping();
        },
      },
    ],
    state: lifecycle,
    logger,
    checkTimeoutMs: 2000,
    metrics,
  });
  lifecycle.onShutdown({ name: 'health', run: () => health.close() });

  await health.listen({ host: config.HOST, port: config.HEALTH_PORT });
  await new Promise<void>((resolve) =>
    http.listen({ port: config.PORT, host: config.HOST, backlog: config.LISTEN_BACKLOG }, resolve),
  );
  lifecycle.markStarted();
  logger.info('realtime.started', { port: config.PORT });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void lifecycle.shutdown(signal).then((exitCode) => process.exit(exitCode));
    });
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error && name === 'ConfigError' ? error.message : undefined;
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', event: 'realtime.boot_failed', errorName: name, errorMessage: message })}\n`,
  );
  process.exit(1);
});
