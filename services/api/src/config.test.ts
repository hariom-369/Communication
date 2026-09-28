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
      }).sort(),
    ).toEqual([
      'ALLOWED_ORIGINS',
      'DATABASE_URL',
      'LOG_ERROR_DETAILS',
      'PUBLIC_WEB_URL',
      'SMTP_URL',
      'VALKEY_URL',
    ]);
  });

  it('never allows unprotected (development) messaging in production', () => {
    expect(issueKeys({ ...production, MESSAGING_DEV_PLAINTEXT: 'true' })).toEqual(['MESSAGING_DEV_PLAINTEXT']);
    expect(loadApiConfig(base).MESSAGING_DEV_PLAINTEXT).toBe(false);
  });

  it('requires every secret and endpoint to be configured explicitly', () => {
    expect(issueKeys({}).sort()).toEqual([
      'ALLOWED_ORIGINS',
      'DATABASE_URL',
      'EMAIL_FROM',
      'PASSWORD_PEPPER',
      'PUBLIC_WEB_URL',
      'SECRET_BOX_KEYS',
      'SMTP_URL',
      'VALKEY_URL',
      'WEBAUTHN_RP_ID',
    ]);
  });
});
