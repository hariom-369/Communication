/**
 * Integration tests require real PostgreSQL and Valkey. Missing configuration is a hard failure,
 * never a silent skip (docs/testing.md).
 */
const missing = ['TEST_DATABASE_URL', 'TEST_VALKEY_URL', 'TEST_S3_URL'].filter(
  (name) => !process.env[name],
);
if (missing.length > 0) {
  throw new Error(
    `Integration tests need ${missing.join(', ')}. Start the services with ` +
      '`docker compose -f infra/docker/compose.yaml up -d` and export the URLs (see CONTRIBUTING.md).',
  );
}

export function requireEnv(name: 'TEST_DATABASE_URL' | 'TEST_VALKEY_URL' | 'TEST_S3_URL'): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}
