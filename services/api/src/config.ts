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
    /** Namespace for all Valkey keys, so environments can share a cluster safely. */
    VALKEY_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .default('tessera'),

    ALLOWED_ORIGINS: env.originList(),
    TRUST_PROXY_HOPS: env.nonNegativeInt(0),
    BODY_LIMIT_BYTES: env.positiveInt(64 * 1024),

    /** Public URL of the web app, used in email links (password reset). */
    PUBLIC_WEB_URL: env.url(['https:', 'http:']),
    SMTP_URL: env.url(['smtp:', 'smtps:']),
    EMAIL_FROM: z.string().min(3),
    /** `<id>:<base64 32 bytes>`; HMAC key applied before Argon2id (docs/authentication.md §2.1). */
    PASSWORD_PEPPER: z.string().min(10),
    /** `<id>:<base64 32 bytes>[,<id>:<key>…]`; first key encrypts, all keys decrypt. */
    SECRET_BOX_KEYS: z.string().min(10),
    /** WebAuthn relying-party ID: the registrable domain of the web app (e.g. tessera.example). */
    WEBAUTHN_RP_ID: z.string().min(1),
    WEBAUTHN_RP_NAME: z.string().min(1).default('Tessera'),
    MAILBOX_RETENTION_DAYS: env.positiveInt(30),
    /**
     * Per-address flood guard (requests per minute, every route). Generous because many users
     * share addresses (CGNAT, offices); signed-in users are limited per user by each route.
     */
    IP_FLOOD_LIMIT_PER_MINUTE: env.positiveInt(1200),
    /** Path (on the web origin) that the edge routes to services/realtime. */
    REALTIME_WS_PATH: z
      .string()
      .regex(/^\/[a-z0-9/_-]*$/)
      .default('/rt/v1/ws'),
    SESSION_IDLE_DAYS: env.positiveInt(30),
    SESSION_ABSOLUTE_DAYS: env.positiveInt(90),

    /** Object storage for end-to-end encrypted attachments (docs/media.md §5). */
    MEDIA_S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    MEDIA_S3_REGION: z.string().min(1).default('ap-south-1'),
    /** S3-compatible endpoint (MinIO locally); unset for AWS. Must be reachable by browsers. */
    MEDIA_S3_ENDPOINT: env.url(['https:', 'http:']).optional(),
    MEDIA_S3_FORCE_PATH_STYLE: env.boolean(false),
    /** Static credentials for local stores only; production uses the instance role. */
    MEDIA_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    MEDIA_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

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
    if (config.MEDIA_S3_ENDPOINT?.startsWith('https://') === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['MEDIA_S3_ENDPOINT'],
        message: 'Must be https in production',
      });
    }
    if (
      config.MEDIA_S3_ACCESS_KEY_ID !== undefined ||
      config.MEDIA_S3_SECRET_ACCESS_KEY !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['MEDIA_S3_ACCESS_KEY_ID'],
        message: 'Use the instance role in production, not static keys',
      });
    }
    if (!config.PUBLIC_WEB_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_WEB_URL'],
        message: 'Must be https in production',
      });
    }
    if (!config.SMTP_URL.startsWith('smtps://') && !config.SMTP_URL.includes('requireTLS=true')) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'Must use smtps:// or requireTLS=true in production',
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
