import {
  createHealthServer,
  createLifecycle,
  createLogger,
  createMetricsRegistry,
} from '@tessera/platform';

import { buildFetcherApp } from './fetcher-app.js';
import { loadFetcherConfig } from './fetcher-config.js';

/** Entry point of the isolated link-preview fetcher deployment (security review F-05). */
async function main(): Promise<void> {
  const config = loadFetcherConfig(process.env);
  // Error details off: errors here may quote third-party responses.
  const logger = createLogger({
    service: 'link-fetcher',
    level: config.LOG_LEVEL,
    errorDetails: false,
  });
  const lifecycle = createLifecycle({
    logger,
    drainDelayMs: config.SHUTDOWN_DRAIN_MS,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  const metrics = createMetricsRegistry('link-fetcher');
  const health = createHealthServer({
    checks: [], // no dependencies: ready as soon as it listens
    state: lifecycle,
    logger,
    checkTimeoutMs: 1_000,
    metrics,
  });
  lifecycle.onShutdown({ name: 'health', run: () => health.close() });
  const app = await buildFetcherApp({
    logger,
    token: config.FETCHER_TOKEN,
    maxConcurrent: config.FETCHER_MAX_CONCURRENT,
    metrics,
  });
  lifecycle.onShutdown({ name: 'http', run: () => app.close() });

  await health.listen({ host: config.HOST, port: config.HEALTH_PORT });
  await app.listen({ host: config.HOST, port: config.PORT });
  lifecycle.markStarted();
  logger.info('fetcher.started', { port: config.PORT });

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
    `${JSON.stringify({ level: 'fatal', event: 'fetcher.boot_failed', errorName: name, errorMessage: message })}\n`,
  );
  process.exit(1);
});
