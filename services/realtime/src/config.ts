import { env, loadConfig } from '@tessera/platform';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: env.nodeEnv(),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: env.port(8081),
    HEALTH_PORT: env.port(9091),
    LOG_LEVEL: env.logLevel(),
    LOG_ERROR_DETAILS: env.boolean(false),
    /** Read-only use: sessions and conversation membership. */
    DATABASE_URL: env.url(['postgres:', 'postgresql:']),
    DATABASE_POOL_MAX: env.positiveInt(5),
    VALKEY_URL: env.url(['redis:', 'rediss:']),
    VALKEY_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .default('tessera'),
    /** Browser origins allowed to open a WebSocket (CSWSH defence). */
    ALLOWED_ORIGINS: env.originList(),
    WS_PATH: z
      .string()
      .regex(/^\/[a-z0-9/_-]*$/)
      .default('/rt/v1/ws'),
    MAX_CONNECTIONS: env.positiveInt(50_000),
    // Pending-connection queue (capped by net.core.somaxconn). Node's default of 511 overflowed
    // when thousands of clients reconnected at once (docs/capacity.md §4).
    LISTEN_BACKLOG: env.positiveInt(4096),
    MAX_CONNECTIONS_PER_USER: env.positiveInt(10),
    HEARTBEAT_SECONDS: env.positiveInt(25),
    AUTH_TIMEOUT_MS: env.positiveInt(5000),
    SESSION_RECHECK_SECONDS: env.positiveInt(60),
    // Deploys: clients are told to reconnect at a random moment within this window, spreading
    // the reconnect storm (docs/realtime.md §5; measured in docs/capacity.md §4). 5 s let 15,000
    // clients of one pod hit the API within 5 s and stalled message sends for seconds.
    SHUTDOWN_DRAIN_MS: env.nonNegativeInt(30_000),
    SHUTDOWN_TIMEOUT_MS: env.positiveInt(45_000),
  })
  .superRefine((config, ctx) => {
    // The drain (plus closing the stragglers) must fit inside the shutdown timeout.
    if (config.SHUTDOWN_TIMEOUT_MS < config.SHUTDOWN_DRAIN_MS + 10_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['SHUTDOWN_TIMEOUT_MS'],
        message: 'Must exceed SHUTDOWN_DRAIN_MS by at least 10 s',
      });
    }
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
        message: 'Must be false in production',
      });
    }
    if (!config.VALKEY_URL.startsWith('rediss://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['VALKEY_URL'],
        message: 'Must use TLS (rediss://) in production',
      });
    }
    if (new URL(config.DATABASE_URL).searchParams.get('sslmode') !== 'verify-full') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'Must set sslmode=verify-full in production',
      });
    }
  });

export type RealtimeConfig = Readonly<z.infer<typeof schema>>;

export function loadRealtimeConfig(
  source: Readonly<Record<string, string | undefined>>,
): RealtimeConfig {
  return loadConfig(schema, source);
}
