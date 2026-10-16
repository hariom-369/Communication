import { ConfigError } from '@tessera/platform';
import { describe, expect, it } from 'vitest';

import { loadApiConfig } from './config.js';

const key = Buffer.alloc(32, 7).toString('base64');

const base = {
  DATABASE_URL: 'postgres://tessera:pw@localhost:5432/tessera',
  VALKEY_URL: 'redis://localhost:6379',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  PUBLIC_WEB_URL: 'http://localhost:5173',
  SMTP_URL: 'smtp://localhost:1025',
  EMAIL_FROM: 'Tessera <no-reply@tessera.localhost>',
  PASSWORD_PEPPER: `p1:${key}`,
  SECRET_BOX_KEYS: `k1:${key}`,
  WEBAUTHN_RP_ID: 'localhost',
  MEDIA_S3_BUCKET: 'tessera-e2ee-media',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  PUBLIC_WEB_URL: 'https://app.tessera.example',
  SMTP_URL: 'smtps://email-smtp.ap-south-1.amazonaws.com:465',
  WEBAUTHN_RP_ID: 'tessera.example',
  DATABASE_URL: 'postgres://tessera:pw@db.internal:5432/tessera?sslmode=verify-full',
  VALKEY_URL: 'rediss://cache.internal:6379',
  ALLOWED_ORIGINS: 'https://app.tessera.example',
  LOG_ERROR_DETAILS: 'false',
  // Shapes only (not real keys): franking key ring, moderation HPKE key pair.
  FRANKING_KEYS: `f1:${Buffer.alloc(32, 7).toString('base64')}`,
  PWNED_PASSWORDS_URL: 'https://pwned.internal.example',
  LINK_PREVIEW_FETCHER_URL: 'http://link-fetcher.tessera.svc.cluster.local:8080',
  LINK_PREVIEW_FETCHER_TOKEN: 'x'.repeat(43),
  MODERATION_HPKE_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url'),
  MODERATION_HPKE_PRIVATE_KEY: Buffer.alloc(32, 9).toString('base64url'),
};

function issueKeys(source: Record<string, string>): string[] {
  try {
    loadApiConfig(source);
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.issues.map((issue) => issue.split(':')[0] ?? '');
  }
}

describe('api config', () => {
  it('applies secure defaults', () => {
    const config = loadApiConfig(base);
    expect(config.BODY_LIMIT_BYTES).toBe(65_536);
    expect(config.LOG_ERROR_DETAILS).toBe(false);
    expect(config.TRUST_PROXY_HOPS).toBe(0);
    expect(config.LISTEN_BACKLOG).toBe(4096);
  });

  it('accepts a hardened production configuration', () => {
    expect(issueKeys(production)).toEqual([]);
  });

  it('requires verifiable, encrypted abuse reports in production', () => {
    const {
      FRANKING_KEYS: _f,
      MODERATION_HPKE_PUBLIC_KEY: _p,
      MODERATION_HPKE_PRIVATE_KEY: _k,
      ...rest
    } = production;
    expect(issueKeys(rest).sort()).toEqual(['FRANKING_KEYS', 'MODERATION_HPKE_PUBLIC_KEY']);
    // Half a key pair is refused everywhere.
    const { MODERATION_HPKE_PRIVATE_KEY: _private, ...publicOnly } = production;
    expect(issueKeys({ ...publicOnly, NODE_ENV: 'development' })).toEqual([
      'MODERATION_HPKE_PUBLIC_KEY',
    ]);
  });

  it('requires the breached-password check in production', () => {
    const { PWNED_PASSWORDS_URL: _url, ...rest } = production;
    expect(issueKeys(rest)).toEqual(['PWNED_PASSWORDS_URL']);
  });

  it('requires the isolated link-preview fetcher in production, with its token', () => {
    const { LINK_PREVIEW_FETCHER_URL: _url, LINK_PREVIEW_FETCHER_TOKEN: _t, ...rest } = production;
    expect(issueKeys(rest)).toEqual(['LINK_PREVIEW_FETCHER_URL']);
    const { LINK_PREVIEW_FETCHER_TOKEN: _token, ...noToken } = production;
    expect(issueKeys({ ...noToken, NODE_ENV: 'development' })).toEqual([
      'LINK_PREVIEW_FETCHER_TOKEN',
    ]);
    expect(issueKeys({ ...production, LINK_PREVIEW_FETCHER_TOKEN: 'short' })).toEqual([
      'LINK_PREVIEW_FETCHER_TOKEN',
    ]);
  });

  it('rejects insecure production settings', () => {
    expect(
      issueKeys({
        ...production,
        ALLOWED_ORIGINS: 'http://app.tessera.example',
        LOG_ERROR_DETAILS: 'true',
        DATABASE_URL: 'postgres://tessera:pw@db.internal:5432/tessera',
        VALKEY_URL: 'redis://cache.internal:6379',
        PUBLIC_WEB_URL: 'http://app.tessera.example',
        SMTP_URL: 'smtp://relay.internal:25',
        MEDIA_S3_ENDPOINT: 'http://minio.internal:9000',
        MEDIA_S3_ACCESS_KEY_ID: 'static',
      }).sort(),
    ).toEqual([
      'ALLOWED_ORIGINS',
      'DATABASE_URL',
      'LOG_ERROR_DETAILS',
      'MEDIA_S3_ACCESS_KEY_ID',
      'MEDIA_S3_ENDPOINT',
      'PUBLIC_WEB_URL',
      'SMTP_URL',
      'VALKEY_URL',
    ]);
  });

  it('requires every secret and endpoint to be configured explicitly', () => {
    expect(issueKeys({}).sort()).toEqual([
      'ALLOWED_ORIGINS',
      'DATABASE_URL',
      'EMAIL_FROM',
      'MEDIA_S3_BUCKET',
      'PASSWORD_PEPPER',
      'PUBLIC_WEB_URL',
      'SECRET_BOX_KEYS',
      'SMTP_URL',
      'VALKEY_URL',
      'WEBAUTHN_RP_ID',
    ]);
  });

  it('configures calls only completely: TURN and the SFU are all-or-nothing', () => {
    const secret = 's'.repeat(40);
    const config = loadApiConfig({
      ...base,
      TURN_URLS: 'turn:turn.example:3478?transport=udp, turns:turn.example:443?transport=tcp',
      TURN_SHARED_SECRET: secret,
      LIVEKIT_URL: '/sfu',
      LIVEKIT_API_URL: 'http://livekit.internal:7880',
      LIVEKIT_API_KEY: 'tessera',
      LIVEKIT_API_SECRET: secret,
    });
    expect(config.TURN_URLS).toEqual([
      'turn:turn.example:3478?transport=udp',
      'turns:turn.example:443?transport=tcp',
    ]);
    expect(config.TURN_TTL_SECONDS).toBe(600);
    expect(issueKeys({ ...base, TURN_URLS: 'turn:turn.example:3478' })).toEqual(['TURN_URLS']);
    expect(
      issueKeys({ ...base, TURN_URLS: 'https://turn.example', TURN_SHARED_SECRET: secret }),
    ).toEqual(['TURN_URLS.0']);
    expect(issueKeys({ ...base, TURN_URLS: 'turn:x', TURN_SHARED_SECRET: 'short' })).toEqual([
      'TURN_SHARED_SECRET',
    ]);
    expect(issueKeys({ ...base, LIVEKIT_URL: '/sfu' })).toEqual(['LIVEKIT_URL']);
    expect(
      issueKeys({
        ...production,
        LIVEKIT_URL: 'ws://sfu.tessera.example',
        LIVEKIT_API_URL: 'http://livekit.internal:7880',
        LIVEKIT_API_KEY: 'tessera',
        LIVEKIT_API_SECRET: secret,
      }),
    ).toEqual(['LIVEKIT_URL']);
  });
});

describe('admin console settings', () => {
  const oidc = {
    ADMIN_OIDC_ISSUER: 'https://login.tessera.example',
    ADMIN_OIDC_CLIENT_ID: 'tessera-admin',
    ADMIN_OIDC_CLIENT_SECRET: 'a-client-secret-of-some-length',
  };

  it('defaults to short sessions and accepts a complete production setup', () => {
    const config = loadApiConfig(base);
    expect(config.ADMIN_SESSION_IDLE_MINUTES).toBe(30);
    expect(config.ADMIN_SESSION_ABSOLUTE_HOURS).toBe(8);
    expect(config.ADMIN_OIDC_ALLOW_INSECURE).toBe(false);
    expect(
      issueKeys({
        ...production,
        ...oidc,
        ADMIN_ORIGINS: 'https://admin.tessera.example',
        ADMIN_PUBLIC_URL: 'https://admin.tessera.example',
        ADMIN_EMAIL_DOMAINS: 'tessera.example',
        ADMIN_AUTHENTICATOR_AAGUIDS: '00000000-0000-0000-0000-000000000001',
        ADMIN_ATTESTATION_ROOTS_FILE: '/etc/tessera/security-key-roots.pem',
      }),
    ).toEqual([]);
  });

  it('refuses longer sessions, half an identity provider and an unverifiable allow-list', () => {
    expect(issueKeys({ ...base, ADMIN_SESSION_ABSOLUTE_HOURS: '12' })).toEqual([
      'ADMIN_SESSION_ABSOLUTE_HOURS',
    ]);
    expect(issueKeys({ ...base, ADMIN_SESSION_IDLE_MINUTES: '60' })).toEqual([
      'ADMIN_SESSION_ABSOLUTE_HOURS',
    ]);
    expect(issueKeys({ ...base, ADMIN_OIDC_ISSUER: oidc.ADMIN_OIDC_ISSUER })).toEqual([
      'ADMIN_OIDC_ISSUER',
    ]);
    expect(issueKeys({ ...base, ...oidc, ADMIN_OIDC_CLIENT_SECRET: 'short' })).toEqual([
      'ADMIN_OIDC_CLIENT_SECRET',
    ]);
    expect(
      issueKeys({ ...base, ADMIN_AUTHENTICATOR_AAGUIDS: '00000000-0000-0000-0000-000000000001' }),
    ).toEqual(['ADMIN_ATTESTATION_ROOTS_FILE']);
  });

  it('refuses plain http and the insecure identity-provider switch in production', () => {
    expect(
      issueKeys({
        ...production,
        ...oidc,
        ADMIN_OIDC_ISSUER: 'http://login.tessera.example',
        ADMIN_ORIGINS: 'http://admin.tessera.example',
        ADMIN_PUBLIC_URL: 'http://admin.tessera.example',
        ADMIN_OIDC_ALLOW_INSECURE: 'true',
      }).sort(),
    ).toEqual([
      'ADMIN_OIDC_ALLOW_INSECURE',
      'ADMIN_OIDC_ISSUER',
      'ADMIN_ORIGINS',
      'ADMIN_PUBLIC_URL',
    ]);
  });
});

describe('billing settings', () => {
  // Built at run time: shapes only, never key-like literals in the repository.
  const fake = (prefix: string) => `${prefix}_${'x'.repeat(24)}`;
  const stripe = {
    STRIPE_SECRET_KEY: fake('sk_live'),
    STRIPE_WEBHOOK_SECRET: fake('whsec'),
    STRIPE_PRICES: 'premium_monthly=price_1',
  };
  const seller = {
    BILLING_SELLER_NAME: 'Tessera Private Limited',
    BILLING_SELLER_ADDRESS: 'Bengaluru',
    BILLING_SELLER_STATE: 'KA',
    BILLING_SELLER_GSTIN: '29ABCDE1234F1Z5',
  };

  it('configures a provider completely or not at all, with a seller for invoices', () => {
    expect(issueKeys({ ...base, ...stripe, ...seller })).toEqual([]);
    const { STRIPE_PRICES: _p, ...partial } = stripe;
    expect(issueKeys({ ...base, ...partial, ...seller })).toEqual(['STRIPE_SECRET_KEY']);
    expect(issueKeys({ ...base, ...stripe })).toEqual(['BILLING_SELLER_NAME']);
    expect(issueKeys({ ...base, ...stripe, ...seller, BILLING_SELLER_STATE: 'MH' })).toEqual([
      'BILLING_SELLER_GSTIN',
    ]);
  });

  it('refuses stand-in provider URLs and test-mode keys in production', () => {
    expect(issueKeys({ ...production, ...stripe, ...seller })).toEqual([]);
    expect(
      issueKeys({
        ...production,
        ...stripe,
        ...seller,
        STRIPE_SECRET_KEY: fake('sk_test'),
        RAZORPAY_API_URL: 'http://127.0.0.1:28997',
      }).sort(),
    ).toEqual(['RAZORPAY_API_URL', 'STRIPE_SECRET_KEY']);
  });
});

describe('push notification settings', () => {
  const vapid = {
    VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url'),
    VAPID_PRIVATE_KEY: Buffer.alloc(32, 9).toString('base64url'),
    VAPID_SUBJECT: 'mailto:ops@tessera.example',
  };

  it('needs all VAPID settings together, with keys of the right size', () => {
    expect(issueKeys({ ...base, ...vapid })).toEqual([]);
    expect(issueKeys({ ...base, VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY })).toEqual([
      'VAPID_PUBLIC_KEY',
    ]);
    expect(
      issueKeys({ ...base, ...vapid, VAPID_PRIVATE_KEY: Buffer.alloc(16).toString('base64url') }),
    ).toEqual(['VAPID_PRIVATE_KEY']);
    expect(issueKeys({ ...base, ...vapid, VAPID_SUBJECT: 'ops@tessera.example' })).toEqual([
      'VAPID_SUBJECT',
    ]);
  });

  it('defaults to the major push services and refuses the test endpoint in production', () => {
    expect(loadApiConfig(base).PUSH_SERVICE_HOSTS).toContain('fcm.googleapis.com');
    expect(issueKeys({ ...base, PUSH_TEST_ENDPOINT_ORIGIN: 'http://127.0.0.1:9999' })).toEqual([]);
    expect(
      issueKeys({ ...production, ...vapid, PUSH_TEST_ENDPOINT_ORIGIN: 'http://127.0.0.1:9999' }),
    ).toEqual(['PUSH_TEST_ENDPOINT_ORIGIN']);
  });
});
