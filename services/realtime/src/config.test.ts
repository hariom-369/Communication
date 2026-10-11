import { ConfigError } from '@tessera/platform';
import { describe, expect, it } from 'vitest';

import { loadRealtimeConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://tessera:pw@localhost:5432/tessera',
  VALKEY_URL: 'redis://localhost:6379',
  ALLOWED_ORIGINS: 'http://localhost:5173',
};

function issues(source: Record<string, string>): string[] {
  try {
    loadRealtimeConfig(source);
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.issues.map((issue) => issue.split(':')[0] ?? '').sort();
  }
}

describe('realtime config', () => {
  it('applies defaults', () => {
    const config = loadRealtimeConfig(base);
    expect(config).toMatchObject({
      PORT: 8081,
      WS_PATH: '/rt/v1/ws',
      MAX_CONNECTIONS_PER_USER: 10,
      HEARTBEAT_SECONDS: 25,
      SHUTDOWN_DRAIN_MS: 30_000,
      SHUTDOWN_TIMEOUT_MS: 45_000,
      LISTEN_BACKLOG: 4096,
    });
  });

  it('keeps the drain window inside the shutdown timeout', () => {
    expect(issues({ ...base, SHUTDOWN_DRAIN_MS: '30000', SHUTDOWN_TIMEOUT_MS: '25000' })).toEqual([
      'SHUTDOWN_TIMEOUT_MS',
    ]);
    expect(issues({ ...base, SHUTDOWN_DRAIN_MS: '0', SHUTDOWN_TIMEOUT_MS: '10000' })).toEqual([]);
  });

  it('enforces TLS and https origins in production', () => {
    expect(issues({ ...base, NODE_ENV: 'production' })).toEqual([
      'ALLOWED_ORIGINS',
      'DATABASE_URL',
      'VALKEY_URL',
    ]);
    expect(
      issues({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://rt:pw@db.internal/tessera?sslmode=verify-full',
        VALKEY_URL: 'rediss://cache.internal:6379',
        ALLOWED_ORIGINS: 'https://app.tessera.example',
      }),
    ).toEqual([]);
  });

  it('rejects unsafe paths', () => {
    expect(issues({ ...base, WS_PATH: 'no-leading-slash' })).toEqual(['WS_PATH']);
  });
});
