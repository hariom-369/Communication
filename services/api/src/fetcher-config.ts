import { env, loadConfig } from '@tessera/platform';
import { z } from 'zod';

/**
 * Configuration of the isolated link-preview fetcher (`fetcher-server.ts`). Deliberately small:
 * no database, Valkey, object storage or keys — only its own token.
 */
const schema = z.object({
  NODE_ENV: env.nodeEnv(),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: env.port(8080),
  HEALTH_PORT: env.port(9090),
  LOG_LEVEL: env.logLevel(),
  /** Shared with the API as LINK_PREVIEW_FETCHER_TOKEN. */
  FETCHER_TOKEN: z.string().min(32).max(256),
  FETCHER_MAX_CONCURRENT: env.positiveInt(32),
  SHUTDOWN_DRAIN_MS: env.nonNegativeInt(5_000),
  SHUTDOWN_TIMEOUT_MS: env.positiveInt(10_000),
});

export type FetcherConfig = Readonly<z.infer<typeof schema>>;

export function loadFetcherConfig(
  source: Readonly<Record<string, string | undefined>>,
): FetcherConfig {
  return loadConfig(schema, source);
}
