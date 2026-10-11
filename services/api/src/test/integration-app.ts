import { randomBytes } from 'node:crypto';

import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { createLogger, type Logger } from '@tessera/platform';
import { CURRENT_TERMS_VERSION } from '@tessera/validation';
import { MemoryDestination } from '@tessera/platform/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { buildApp } from '../app.js';
import { composeModules, type Modules } from '../compose.js';
import { generateModerationKeyPair, ModerationKey } from '../modules/moderation/index.js';
import type { Database } from '../db/schema.js';
import { MIGRATIONS_DIR } from '../paths.js';
import type { EmailMessage, Mailer } from '../platform/email.js';
import { SESSION_COOKIE } from '../platform/http/routes.js';
import { loadMigrations, migrate } from '@tessera/platform';
import { S3ObjectStore } from '../platform/object-store.js';
import { ValkeyRateLimiter } from '../platform/rate-limit.js';
import { createValkey } from '../platform/valkey.js';

import type { FakePayments } from './fake-payments.js';
import { requireEnv } from './integration-env.js';
import webpush from 'web-push';

export const ORIGIN = 'https://app.tessera.test';

/** Billing configured against the payment stand-in; the seller is registered in Karnataka. */
export function billingTestConfig(payments: FakePayments) {
  const { credentials, url: standInUrl } = payments;
  return {
    STRIPE_SECRET_KEY: credentials.stripeSecretKey,
    STRIPE_WEBHOOK_SECRET: credentials.stripeWebhookSecret,
    STRIPE_PRICES:
      'premium_monthly=price_premium_monthly,premium_yearly=price_premium_yearly,creator_monthly=price_creator_monthly',
    STRIPE_API_URL: standInUrl,
    RAZORPAY_KEY_ID: credentials.razorpayKeyId,
    RAZORPAY_KEY_SECRET: credentials.razorpayKeySecret,
    RAZORPAY_WEBHOOK_SECRET: credentials.razorpayWebhookSecret,
    RAZORPAY_PLANS:
      'premium_monthly=plan_premium_monthly,premium_yearly=plan_premium_yearly,creator_monthly=plan_creator_monthly',
    RAZORPAY_API_URL: standInUrl,
    BILLING_SELLER_NAME: 'Tessera Test Private Limited',
    BILLING_SELLER_ADDRESS: '1 Test Road, Bengaluru 560001',
    BILLING_SELLER_GSTIN: '29ABCDE1234F1Z5',
    BILLING_SELLER_STATE: 'KA',
    BILLING_SAC_CODE: '998439',
  };
}
export const TEST_TURN_SECRET = 'turn-secret-for-integration-tests-only-0123456789';
export const TEST_LIVEKIT_SECRET = 'livekit-secret-for-integration-tests-only-0123456789';
export const RP_ID = 'app.tessera.test';

/** Captures outgoing email in memory (the SMTP transport itself is tested separately). */
export class RecordingMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to.toLowerCase() === address.toLowerCase());
  }

  lastCode(address: string): string {
    const match = /verification code is: (\d{6})/.exec(this.to(address).at(-1)?.text ?? '');
    if (match?.[1] === undefined) throw new Error(`No verification code sent to ${address}`);
    return match[1];
  }

  lastResetToken(address: string): string {
    const match = /#token=([A-Za-z0-9_-]{43})/.exec(this.to(address).at(-1)?.text ?? '');
    if (match?.[1] === undefined) throw new Error(`No reset link sent to ${address}`);
    return match[1];
  }
}

export interface IntegrationApp {
  app: FastifyInstance;
  db: Kysely<Database>;
  valkey: Redis;
  mailer: RecordingMailer;
  modules: Modules;
  logs: MemoryDestination;
  logger: Logger;
  keyPrefix: string;
  media: S3ObjectStore;
  bucket: string;
  /** Public key report bundles are sealed to (base64url). */
  moderationPublicKey: string;
  close(): Promise<void>;
}

/** Full application over a fresh, migrated database and the real Valkey. */
/** Test VAPID keys, generated once per test process (never a real key). */
export const TEST_VAPID = webpush.generateVAPIDKeys();

export async function startIntegrationApp(
  options: {
    pushTestOrigin?: string;
    /** Billing against a stand-in for both payment providers (src/test/fake-payments.ts). */
    payments?: FakePayments;
    /** Realtime ticket admission (tickets per second, cluster-wide); default unlimited. */
    ticketsPerSecond?: number;
  } = {},
): Promise<IntegrationApp> {
  const adminUrl = requireEnv('TEST_DATABASE_URL');
  const name = `tessera_app_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  // Teardown force-drops the database, which terminates any connection still closing.
  pool.on('error', () => undefined);

  const logs = new MemoryDestination();
  const logger = createLogger({
    service: 'api-it',
    level: 'debug',
    errorDetails: true,
    destination: logs,
  });
  await migrate(pool, await loadMigrations(MIGRATIONS_DIR), logger);

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const valkey = createValkey(requireEnv('TEST_VALKEY_URL'), 'tessera-it');
  await valkey.connect();
  const mailer = new RecordingMailer();
  const keyPrefix = name.replaceAll('_', '-').slice(0, 32);
  const key = () => randomBytes(32).toString('base64');
  // A bucket per test app on the S3-compatible test store (docs/testing.md).
  const bucket = name.replaceAll('_', '-');
  const media = new S3ObjectStore({
    bucket,
    region: 'us-east-1',
    endpoint: requireEnv('TEST_S3_URL'),
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await media.client.send(new CreateBucketCommand({ Bucket: bucket }));
  const moderationPair = await generateModerationKeyPair();
  const moderationKey = await ModerationKey.load(
    moderationPair.publicKey,
    moderationPair.privateKey,
  );
  const modules = composeModules(
    {
      PASSWORD_PEPPER: `p1:${key()}`,
      SECRET_BOX_KEYS: `k1:${key()}`,
      WEBAUTHN_RP_ID: RP_ID,
      WEBAUTHN_RP_NAME: 'Tessera',
      ALLOWED_ORIGINS: [ORIGIN],
      PUBLIC_WEB_URL: ORIGIN,
      SESSION_IDLE_DAYS: 30,
      SESSION_ABSOLUTE_DAYS: 90,
      BUILD_VERSION: 'it',
      BUILD_COMMIT: 'it',
      VALKEY_KEY_PREFIX: keyPrefix,
      MAILBOX_RETENTION_DAYS: 30,
      REALTIME_WS_PATH: '/rt/v1/ws',
      TURN_URLS: [
        'turn:turn.tessera.test:3478?transport=udp',
        'turns:turn.tessera.test:443?transport=tcp',
      ],
      TURN_SHARED_SECRET: TEST_TURN_SECRET,
      TURN_TTL_SECONDS: 600,
      STUN_URLS: undefined,
      // No SFU runs in integration tests: room control calls fail fast and are best effort.
      LIVEKIT_URL: '/sfu',
      LIVEKIT_API_URL: 'http://127.0.0.1:9',
      LIVEKIT_API_KEY: 'tessera-it',
      LIVEKIT_API_SECRET: TEST_LIVEKIT_SECRET,
      CALL_RECORD_RETENTION_DAYS: 90,
      VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
      VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
      VAPID_SUBJECT: 'mailto:push-tests@tessera.test',
      PUSH_SERVICE_HOSTS: ['push.tessera.test'],
      PUSH_TEST_ENDPOINT_ORIGIN: options.pushTestOrigin,
      SECURITY_ALERT_RETENTION_DAYS: 180,
      FRANKING_KEYS: `f1:${key()}`,
      EVIDENCE_RETENTION_DAYS: 365,
      REALTIME_TICKETS_PER_SECOND: options.ticketsPerSecond ?? 0,
      ...(options.payments === undefined ? {} : billingTestConfig(options.payments)),
    },
    { db, valkey, mailer, logger, media, moderationKey },
  );
  const app = await buildApp({
    logger,
    // Unique prefix: rate-limit state never leaks between test apps.
    rateLimiter: new ValkeyRateLimiter(valkey, `rl-${name}`),
    allowedOrigins: [ORIGIN],
    trustProxyHops: 0,
    bodyLimitBytes: 64 * 1024,
    hsts: true,
    routes: modules.routes,
    sessions: modules.sessions,
    standing: modules.moderation,
  });

  return {
    app,
    db,
    valkey,
    mailer,
    modules,
    logs,
    logger,
    keyPrefix,
    media,
    bucket,
    moderationPublicKey: moderationPair.publicKey,
    close: async () => {
      await app.close();
      await db.destroy();
      await valkey.quit();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

let ipCounter = 0;

/**
 * A browser-like client: keeps the session cookie, sends the CSRF header and Origin like our web
 * app does. Each client gets its own IP address so per-IP limits behave like separate users.
 */
export class TestClient {
  cookie: string | undefined;
  readonly ip: string;

  constructor(
    readonly app: FastifyInstance,
    options: { ip?: string; userAgent?: string } = {},
  ) {
    ipCounter += 1;
    this.ip = options.ip ?? `198.51.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
    this.userAgent =
      options.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  }

  readonly userAgent: string;

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      origin: ORIGIN,
      'sec-fetch-site': 'same-site',
      'x-tessera-csrf': '1',
      'user-agent': this.userAgent,
    };
    if (this.cookie !== undefined) headers['cookie'] = `${SESSION_COOKIE}=${this.cookie}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const setCookie = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    if (setCookie !== undefined) {
      const expired =
        setCookie.value === '' ||
        (setCookie.expires !== undefined && setCookie.expires.getTime() < Date.now());
      this.cookie = expired ? undefined : setCookie.value;
    }
    return response;
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body: unknown = {}) => this.request('POST', url, body);
  put = (url: string, body: unknown) => this.request('PUT', url, body);
  patch = (url: string, body: unknown) => this.request('PATCH', url, body);
  delete = (url: string) => this.request('DELETE', url);
}

export const STRONG_PASSWORD = 'correct-horse-battery-staple-91'; // gitleaks:allow (test fixture)

/** Unique test identity. */
export function identity(): { email: string; username: string } {
  const suffix = randomBytes(4).toString('hex');
  return { email: `user_${suffix}@example.test`, username: `user_${suffix}` };
}

/** Signs up, verifies email and sets a password; returns an active client. */
export async function createActiveUser(
  it: IntegrationApp,
  options: { password?: string } = {},
): Promise<{ client: TestClient; email: string; username: string; password: string }> {
  const { email, username } = identity();
  const password = options.password ?? STRONG_PASSWORD;
  const client = new TestClient(it.app);
  const signup = await client.post('/api/v1/accounts', {
    email,
    username,
    confirmsAdult: true,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
  });
  if (signup.statusCode !== 202) throw new Error(`signup failed: ${signup.body}`);
  const verify = await client.post('/api/v1/accounts/verify-email', {
    email,
    code: it.mailer.lastCode(email),
  });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.body}`);
  const set = await client.post('/api/v1/auth/password/initial', { password });
  if (set.statusCode !== 200) throw new Error(`set password failed: ${set.body}`);
  return { client, email, username, password };
}
