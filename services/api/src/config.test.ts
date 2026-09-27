import { ConfigError } from '@tessera/platform';
import { describe, expect, it } from 'vitest';

import { loadApiConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://tessera:pw@localhost:5432/tessera',
  VALKEY_URL: 'redis://localhost:6379',
  ALLOWED_ORIGINS: 'http://localhost:5173',
};

const production = {
  NODE_ENV: 'production',
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
      }).sort(),
    ).toEqual(['ALLOWED_ORIGINS', 'DATABASE_URL', 'LOG_ERROR_DETAILS', 'VALKEY_URL']);
  });

  it('requires database, cache and origins', () => {
    expect(issueKeys({}).sort()).toEqual(['ALLOWED_ORIGINS', 'DATABASE_URL', 'VALKEY_URL']);
  });
});
