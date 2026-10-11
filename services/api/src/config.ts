import { env, loadConfig } from '@tessera/platform';
import { INDIAN_STATES } from '@tessera/validation';
import { z } from 'zod';

/** Comma-separated ICE server URLs with the given schemes (RFC 7064/7065). */
const iceUrlList = (schemes: readonly string[]) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .max(200)
            .refine((url) => schemes.some((scheme) => url.startsWith(scheme)), {
              message: `Must start with ${schemes.join(' or ')}`,
            }),
        )
        .min(1),
    );

const base64urlKey = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, { message: 'Must be base64url' })
    .refine((value) => Buffer.from(value, 'base64url').length === bytes, {
      message: `Must be ${bytes} bytes`,
    });

/** Push services pushes may be sent to (hostname or parent domain), comma-separated. */
const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
].join(',');

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
    // Pending-connection queue of the listening socket (the kernel caps it at net.core.somaxconn).
    // Node's default of 511 overflowed during reconnect storms: dropped SYNs cost clients 1–3 s
    // retransmission delays while the process was mostly idle (docs/capacity.md §4).
    LISTEN_BACKLOG: env.positiveInt(4096),
    // Realtime tickets per second across the cluster (0 = unlimited, the default). Off by default
    // because the load tests showed it does not protect connected users when a realtime pod
    // crashes — a refused ticket costs the API about as much as a granted one — while it slows
    // recovery (docs/capacity.md §4). A guard for an API tier known to be smaller than its
    // realtime tier; refused clients are told to retry after 1–10 s, spread at random.
    REALTIME_TICKETS_PER_SECOND: env.nonNegativeInt(0),
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
    /** How often scheduled channel posts and ownership transfers are applied (ms). */
    CHANNEL_SCHEDULER_INTERVAL_MS: env.positiveInt(15_000),
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

    /**
     * Calls (docs/calling.md). TURN relays use coturn's shared-secret scheme: comma-separated
     * `turn:`/`turns:` URLs and the `static-auth-secret` shared with coturn.
     */
    TURN_URLS: iceUrlList(['turn:', 'turns:']).optional(),
    TURN_SHARED_SECRET: z.string().min(32).optional(),
    TURN_TTL_SECONDS: env.positiveInt(600),
    STUN_URLS: iceUrlList(['stun:', 'stuns:']).optional(),
    /** Group calls: LiveKit SFU. `LIVEKIT_URL` is given to browsers (a path on the web origin or wss://). */
    LIVEKIT_URL: z
      .string()
      .regex(/^(\/[a-z0-9/_-]*|wss?:\/\/[^\s]+)$/i)
      .optional(),
    LIVEKIT_API_URL: env.url(['https:', 'http:']).optional(),
    LIVEKIT_API_KEY: z.string().min(3).optional(),
    LIVEKIT_API_SECRET: z.string().min(32).optional(),
    CALL_RECORD_RETENTION_DAYS: env.positiveInt(90),
    CALL_SWEEP_INTERVAL_MS: env.positiveInt(15_000),

    /** Web Push (RFC 8292 VAPID). Without the keys, push is unavailable (the app says so). */
    VAPID_PUBLIC_KEY: base64urlKey(65).optional(),
    VAPID_PRIVATE_KEY: base64urlKey(32).optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:\/\/)/, { message: 'Must be a mailto: or https:// contact' })
      .optional(),
    PUSH_SERVICE_HOSTS: z
      .string()
      .default(DEFAULT_PUSH_HOSTS)
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== ''),
      ),
    /** Local and E2E testing only: an extra push endpoint origin (may be http on loopback). */
    PUSH_TEST_ENDPOINT_ORIGIN: env.url(['http:', 'https:']).optional(),
    NOTIFY_INTERVAL_MS: env.positiveInt(1000),

    /** Message franking (ADR-021): server MAC keys, `id:base64(32 bytes)`, newest first. */
    FRANKING_KEYS: z.string().min(1).optional(),
    /**
     * Report evidence is encrypted to this HPKE key pair (RFC 9180, DHKEM P-256). The private
     * key opens evidence for moderators only; production keeps it in the secrets manager.
     */
    MODERATION_HPKE_PUBLIC_KEY: base64urlKey(65).optional(),
    MODERATION_HPKE_PRIVATE_KEY: base64urlKey(32).optional(),
    MODERATION_SWEEP_INTERVAL_MS: env.positiveInt(60_000),
    EVIDENCE_RETENTION_DAYS: env.positiveInt(365),
    SECURITY_ALERT_RETENTION_DAYS: env.positiveInt(180),

    /**
     * Admin console (docs/admin.md, ADR-050): served by a separate process (`admin-server`) on
     * its own port and origin, reachable only through the identity-aware proxy. Staff sign in with
     * the corporate identity provider (OIDC) and then a hardware-bound security key.
     */
    ADMIN_PORT: env.port(8082),
    ADMIN_HEALTH_PORT: env.port(9092),
    ADMIN_ORIGINS: env.originList().optional(),
    /** Where the admin SPA is served (OIDC redirect target: `<url>/auth/callback`). */
    ADMIN_PUBLIC_URL: env.url(['https:', 'http:']).optional(),
    ADMIN_OIDC_ISSUER: env.url(['https:', 'http:']).optional(),
    ADMIN_OIDC_CLIENT_ID: z.string().min(1).max(200).optional(),
    ADMIN_OIDC_CLIENT_SECRET: z.string().min(16).max(500).optional(),
    /** Email domains whose staff may sign in (comma-separated); others are refused. */
    ADMIN_EMAIL_DOMAINS: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== ''),
      )
      .optional(),
    /** Local and E2E testing only: talk to the identity provider over plain HTTP. */
    ADMIN_OIDC_ALLOW_INSECURE: env.boolean(false),
    ADMIN_WEBAUTHN_RP_ID: z.string().min(1).max(253).optional(),
    /**
     * Allowed security-key models (AAGUIDs, comma-separated); empty = any hardware-bound key. With
     * a list, keys must present a `packed` attestation certificate chaining to one of the vendor
     * roots in ADMIN_ATTESTATION_ROOTS_FILE (a PEM bundle), so the model claim is verifiable.
     */
    ADMIN_ATTESTATION_ROOTS_FILE: z.string().min(1).max(1024).optional(),
    ADMIN_AUTHENTICATOR_AAGUIDS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== ''),
      ),
    ADMIN_SESSION_IDLE_MINUTES: env.positiveInt(30),
    ADMIN_SESSION_ABSOLUTE_HOURS: env.positiveInt(8),

    /**
     * Billing (docs/billing.md, ADR-051). Each provider is configured completely or not at all;
     * the price maps name the provider's price (Stripe) or plan (Razorpay) id for each of our
     * plans: `premium_monthly=price_123,creator_monthly=price_456`.
     */
    STRIPE_SECRET_KEY: z.string().min(16).max(500).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(16).max(500).optional(),
    STRIPE_PRICES: z.string().min(1).max(2000).optional(),
    /** Testing only (a stand-in provider); production uses the default. */
    STRIPE_API_URL: env.url(['https:', 'http:']).default('https://api.stripe.com'),
    RAZORPAY_KEY_ID: z.string().min(8).max(200).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(16).max(500).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(16).max(500).optional(),
    RAZORPAY_PLANS: z.string().min(1).max(2000).optional(),
    RAZORPAY_API_URL: env.url(['https:', 'http:']).default('https://api.razorpay.com'),
    /** The seller on tax invoices (required when any provider is configured). */
    BILLING_SELLER_NAME: z.string().min(1).max(200).optional(),
    BILLING_SELLER_ADDRESS: z.string().min(1).max(500).optional(),
    BILLING_SELLER_GSTIN: z
      .string()
      .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
      .optional(),
    /** ISO 3166-2:IN state of the seller's GST registration (CGST/SGST vs IGST). */
    BILLING_SELLER_STATE: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    /** Services Accounting Code on invoices (to confirm with the tax adviser, L-11). */
    BILLING_SAC_CODE: z
      .string()
      .regex(/^\d{6}$/)
      .default('998439'),

    BUILD_VERSION: z.string().min(1).default('0.0.0-dev'),
    BUILD_COMMIT: z.string().min(1).default('unknown'),
    SHUTDOWN_DRAIN_MS: env.nonNegativeInt(5000),
    SHUTDOWN_TIMEOUT_MS: env.positiveInt(25_000),
  })
  .superRefine((config, ctx) => {
    const turn = [config.TURN_URLS, config.TURN_SHARED_SECRET];
    if (turn.some((v) => v !== undefined) && turn.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_URLS'],
        message: 'Set TURN_URLS and TURN_SHARED_SECRET together',
      });
    }
    const sfu = [
      config.LIVEKIT_URL,
      config.LIVEKIT_API_URL,
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
    ];
    if (sfu.some((v) => v !== undefined) && sfu.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['LIVEKIT_URL'],
        message:
          'Set LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together',
      });
    }
    const vapid = [config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT];
    if (vapid.some((v) => v !== undefined) && vapid.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_PUBLIC_KEY'],
        message: 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together',
      });
    }
    const moderationKey = [config.MODERATION_HPKE_PUBLIC_KEY, config.MODERATION_HPKE_PRIVATE_KEY];
    if (moderationKey.some((v) => v !== undefined) && moderationKey.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MODERATION_HPKE_PUBLIC_KEY'],
        message: 'Set MODERATION_HPKE_PUBLIC_KEY and MODERATION_HPKE_PRIVATE_KEY together',
      });
    }
    const oidc = [
      config.ADMIN_OIDC_ISSUER,
      config.ADMIN_OIDC_CLIENT_ID,
      config.ADMIN_OIDC_CLIENT_SECRET,
    ];
    if (oidc.some((v) => v !== undefined) && oidc.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_OIDC_ISSUER'],
        message:
          'Set ADMIN_OIDC_ISSUER, ADMIN_OIDC_CLIENT_ID and ADMIN_OIDC_CLIENT_SECRET together',
      });
    }
    if (
      config.ADMIN_AUTHENTICATOR_AAGUIDS.length > 0 &&
      config.ADMIN_ATTESTATION_ROOTS_FILE === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_ATTESTATION_ROOTS_FILE'],
        message: 'A security-key allow-list needs the vendor attestation roots to check it against',
      });
    }
    const providers = {
      STRIPE_SECRET_KEY: [
        config.STRIPE_SECRET_KEY,
        config.STRIPE_WEBHOOK_SECRET,
        config.STRIPE_PRICES,
      ],
      RAZORPAY_KEY_ID: [
        config.RAZORPAY_KEY_ID,
        config.RAZORPAY_KEY_SECRET,
        config.RAZORPAY_WEBHOOK_SECRET,
        config.RAZORPAY_PLANS,
      ],
    } as const;
    for (const [key, values] of Object.entries(providers))
      if (values.some((v) => v !== undefined) && values.some((v) => v === undefined))
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Configure every setting of a payment provider, or none (docs/billing.md)',
        });
    const anyProvider = Object.values(providers).some((values) =>
      values.every((v) => v !== undefined),
    );
    if (
      anyProvider &&
      (config.BILLING_SELLER_NAME === undefined ||
        config.BILLING_SELLER_ADDRESS === undefined ||
        config.BILLING_SELLER_STATE === undefined)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_SELLER_NAME'],
        message: 'Invoices need the seller name, address and state',
      });
    if (
      config.BILLING_SELLER_GSTIN !== undefined &&
      config.BILLING_SELLER_STATE !== undefined &&
      (INDIAN_STATES as Record<string, { gst: string } | undefined>)[config.BILLING_SELLER_STATE]
        ?.gst !== config.BILLING_SELLER_GSTIN.slice(0, 2)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_SELLER_GSTIN'],
        message: 'The GSTIN does not belong to BILLING_SELLER_STATE',
      });
    if (config.ADMIN_SESSION_ABSOLUTE_HOURS > 8 || config.ADMIN_SESSION_IDLE_MINUTES > 30) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_SESSION_ABSOLUTE_HOURS'],
        message: 'Admin sessions last at most 8 hours, idle at most 30 minutes (docs/admin.md §1)',
      });
    }
    if (config.NODE_ENV !== 'production') return;
    for (const required of ['FRANKING_KEYS', 'MODERATION_HPKE_PUBLIC_KEY'] as const) {
      if (config[required] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [required],
          message: 'Required in production (abuse reports must be verifiable and encrypted)',
        });
    }
    for (const [key, value, official] of [
      ['STRIPE_API_URL', config.STRIPE_API_URL, 'https://api.stripe.com'],
      ['RAZORPAY_API_URL', config.RAZORPAY_API_URL, 'https://api.razorpay.com'],
    ] as const)
      if (value.replace(/\/$/, '') !== official)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Testing only; must not be set in production',
        });
    if (
      (config.STRIPE_SECRET_KEY?.startsWith('sk_test_') ?? false) ||
      (config.RAZORPAY_KEY_ID?.startsWith('rzp_test_') ?? false)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'Test-mode payment keys must not be used in production',
      });
    if (config.ADMIN_OIDC_ALLOW_INSECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_OIDC_ALLOW_INSECURE'],
        message: 'Not allowed in production',
      });
    }
    for (const key of ['ADMIN_PUBLIC_URL', 'ADMIN_OIDC_ISSUER'] as const) {
      const value = config[key];
      if (value !== undefined && !value.startsWith('https:'))
        ctx.addIssue({ code: 'custom', path: [key], message: 'Must use https in production' });
    }
    if (config.ADMIN_ORIGINS?.some((origin) => !origin.startsWith('https:')) === true)
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_ORIGINS'],
        message: 'Must use https in production',
      });
    if (config.PUSH_TEST_ENDPOINT_ORIGIN !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUSH_TEST_ENDPOINT_ORIGIN'],
        message: 'Testing only; must not be set in production',
      });
    }
    if (config.LIVEKIT_URL?.startsWith('ws://') === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['LIVEKIT_URL'],
        message: 'Must be wss:// or a path on the web origin in production',
      });
    }
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
