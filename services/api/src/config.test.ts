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
