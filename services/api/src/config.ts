import { env, loadConfig } from '@tessera/platform';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: env.nodeEnv(),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: env.port(8080),
    HEALTH_PORT: env.port(9090),
    LOG_LEVEL: env.logLevel(),
    LOG_ERROR_DETAILS: env.boolean(false),

    DATABASE_URL: env.url(['postgres:', 'postgresql:']),
    DATABASE_POOL_MAX: env.positiveInt(10),
    DATABASE_STATEMENT_TIMEOUT_MS: env.positiveInt(5000),
    VALKEY_URL: env.url(['redis:', 'rediss:']),

    ALLOWED_ORIGINS: env.originList(),
    TRUST_PROXY_HOPS: env.nonNegativeInt(0),
    BODY_LIMIT_BYTES: env.positiveInt(64 * 1024),

    BUILD_VERSION: z.string().min(1).default('0.0.0-dev'),
    BUILD_COMMIT: z.string().min(1).default('unknown'),
    SHUTDOWN_DRAIN_MS: env.nonNegativeInt(5000),
    SHUTDOWN_TIMEOUT_MS: env.positiveInt(25_000),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;
    if (config.ALLOWED_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: 'Must use https:// origins in production',
      });
    }
    if (config.LOG_ERROR_DETAILS) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_ERROR_DETAILS'],
        message: 'Must be false in production (logs must not carry third-party error text)',
      });
    }
    if (new URL(config.DATABASE_URL).searchParams.get('sslmode') !== 'verify-full') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'Must set sslmode=verify-full in production',
      });
    }
    if (!config.VALKEY_URL.startsWith('rediss://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['VALKEY_URL'],
        message: 'Must use TLS (rediss://) in production',
      });
    }
  });

export type ApiConfig = Readonly<z.infer<typeof schema>>;

export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  return loadConfig(schema, source);
}
