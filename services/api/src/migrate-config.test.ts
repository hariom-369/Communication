import { ConfigError } from '@tessera/platform';
import { describe, expect, it } from 'vitest';

import { loadMigrateConfig } from './migrate-config.js';

describe('migration job config', () => {
  it('needs only the database, so the job holds none of the API keys', () => {
    expect(
      loadMigrateConfig({ DATABASE_URL: 'postgres://migrator@db:5432/tessera' }),
    ).toMatchObject({ NODE_ENV: 'development', LOG_ERROR_DETAILS: false });
  });

  it('requires a verified TLS connection in production', () => {
    expect(() =>
      loadMigrateConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://migrator@db:5432/tessera',
      }),
    ).toThrow(ConfigError);
    expect(
      loadMigrateConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://migrator@db:5432/tessera?sslmode=verify-full',
      }).NODE_ENV,
    ).toBe('production');
  });
});
