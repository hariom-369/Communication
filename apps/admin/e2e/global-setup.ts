import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * Starts the admin stack for E2E tests:
 *   PostgreSQL database `tessera_admin_e2e` (fresh, migrated, with a few user accounts) · Valkey
 *   (existing) · test identity provider on 127.0.0.1:58300 · admin API (`admin-server`) on
 *   :58082 · admin console preview on :4174.
 * Requires TEST_DATABASE_URL, TEST_VALKEY_URL and TEST_S3_URL, like the integration tests.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const IDP_PORT = 58300;
const ADMIN_PORT = 58082;
const ADMIN_HEALTH_PORT = 59092;
export const ADMIN_ORIGIN = 'http://localhost:4174';

/** Staff the operator command creates before the suite (break glass, as in production). */
export const STAFF = {
  alice: { email: 'alice@tessera.test', roles: ['super_admin'] },
  bob: { email: 'bob@tessera.test', roles: ['super_admin'] },
  sam: { email: 'sam@tessera.test', roles: ['support_agent'] },
  eve: { email: 'eve@tessera.test', roles: ['analyst'], eligible: 'security_admin' },
  sync: { email: 'sync@tessera.test', roles: ['analyst'] },
  ada: { email: 'ada@tessera.test', roles: ['super_admin'] },
} as const;

/** User accounts the console looks at. */
export const PEOPLE = [
  { username: 'river_e2e', email: 'river@people.test' },
  { username: 'sky_e2e', email: 'sky@people.test' },
] as const;

/** A UUIDv7 (the API's id format; RFC 9562 §5.7). */
function uuidv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`E2E tests need ${name}.`);
  return value;
}

function start(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  log: string,
): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
  const out = createWriteStream(log);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on('exit', resolve));
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = required('TEST_DATABASE_URL');
  const valkeyUrl = required('TEST_VALKEY_URL');
  const s3 = new URL(required('TEST_S3_URL'));
  const logs = path.join(ROOT, 'apps/admin/test-results');
  await import('node:fs/promises').then((fs) => fs.mkdir(logs, { recursive: true }));

  const name = 'tessera_admin_e2e';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  process.env['E2E_ADMIN_DATABASE_URL'] = databaseUrl.toString();

  // The bucket the health check probes (the S3-compatible test store accepts unsigned requests).
  await fetch(`${s3.origin}/tessera-admin-e2e`, { method: 'PUT' });
  const apiDir = path.join(ROOT, 'services/api');
  // The test identity provider runs as its own process (services/api/scripts/fake-idp.mjs).
  const idp = {
    issuer: `http://127.0.0.1:${String(IDP_PORT)}`,
    clientId: 'tessera-admin',
    clientSecret: randomBytes(24).toString('base64url'),
  };
  const idpProcess = start(
    'node',
    ['scripts/fake-idp.mjs'],
    { FAKE_IDP_PORT: String(IDP_PORT), FAKE_IDP_CLIENT_SECRET: idp.clientSecret },
    apiDir,
    path.join(logs, 'identity-provider.log'),
  );
  await waitFor(`${idp.issuer}/.well-known/openid-configuration`);
  // A provider left over from an earlier run would answer instead (with another secret).
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (idpProcess.exitCode !== null)
    throw new Error(
      `The test identity provider could not start (port ${String(IDP_PORT)} in use?)`,
    );
  const key = () => randomBytes(32).toString('base64');
  const env = {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl.toString(),
    VALKEY_URL: valkeyUrl,
    VALKEY_KEY_PREFIX: `admin-e2e-${Date.now().toString(36)}`,
    ALLOWED_ORIGINS: 'http://localhost:4173',
    PUBLIC_WEB_URL: 'http://localhost:4173',
    SMTP_URL: 'smtp://127.0.0.1:9?ignoreTLS=true',
    EMAIL_FROM: 'Tessera <no-reply@tessera.localhost>',
    PASSWORD_PEPPER: `p1:${key()}`,
    SECRET_BOX_KEYS: `k1:${key()}`,
    WEBAUTHN_RP_ID: 'localhost',
    MEDIA_S3_BUCKET: 'tessera-admin-e2e',
    MEDIA_S3_REGION: 'us-east-1',
    MEDIA_S3_ENDPOINT: s3.origin,
    MEDIA_S3_FORCE_PATH_STYLE: 'true',
    MEDIA_S3_ACCESS_KEY_ID: 'e2e',
    MEDIA_S3_SECRET_ACCESS_KEY: 'e2e',
    SHUTDOWN_DRAIN_MS: '0',
    ADMIN_PORT: String(ADMIN_PORT),
    ADMIN_HEALTH_PORT: String(ADMIN_HEALTH_PORT),
    ADMIN_ORIGINS: ADMIN_ORIGIN,
    ADMIN_PUBLIC_URL: ADMIN_ORIGIN,
    ADMIN_OIDC_ISSUER: idp.issuer,
    ADMIN_OIDC_CLIENT_ID: idp.clientId,
    ADMIN_OIDC_CLIENT_SECRET: idp.clientSecret,
    ADMIN_EMAIL_DOMAINS: 'tessera.test',
    ADMIN_OIDC_ALLOW_INSECURE: 'true',
    ADMIN_WEBAUTHN_RP_ID: 'localhost',
  };
  if (!existsSync(path.join(apiDir, 'dist', 'admin-server.js')))
    throw new Error('Run `pnpm build` before the E2E tests.');
  const run = async (args: string[]) => {
    const child = start('node', args, env, apiDir, path.join(logs, 'cli.log'));
    if ((await exited(child)) !== 0) throw new Error(`failed: ${args.join(' ')}`);
  };
  await run(['dist/cli/migrate.js']);

  // People to look at, created directly (the user API is not part of this stack).
  const db = new pg.Client({ connectionString: databaseUrl.toString() });
  await db.connect();
  for (const person of PEOPLE) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (id, username, status, accepted_terms_version, confirmed_adult_at)
       VALUES ($1, $2, 'active', 'e2e', now()) RETURNING id`,
      [uuidv7(), person.username],
    );
    await db.query('INSERT INTO user_emails (user_id, email, verified_at) VALUES ($1, $2, now())', [
      rows[0]?.id,
      person.email,
    ]);
  }
  await db.end();

  for (const [handle, staff] of Object.entries(STAFF)) {
    await run(['dist/cli/admin.js', 'create', staff.email, handle, '--by', 'e2e-setup']);
    for (const role of staff.roles)
      await run([
        'dist/cli/admin.js',
        'grant',
        staff.email,
        role,
        '--hours',
        role === 'super_admin' ? '8' : '720',
        '--by',
        'e2e-setup',
      ]);
    if ('eligible' in staff)
      await run([
        'dist/cli/admin.js',
        'eligible',
        staff.email,
        staff.eligible,
        '--by',
        'e2e-setup',
      ]);
  }

  const server = start(
    'node',
    ['dist/admin-server.js'],
    env,
    apiDir,
    path.join(logs, 'admin-server.log'),
  );
  await waitFor(`http://127.0.0.1:${String(ADMIN_HEALTH_PORT)}/readyz`);

  const adminDir = path.join(ROOT, 'apps/admin');
  if (!existsSync(path.join(adminDir, 'dist', 'index.html')))
    throw new Error('Run `pnpm build` before the E2E tests.');
  const web = start(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', 'localhost'],
    { TESSERA_ADMIN_API_URL: `http://127.0.0.1:${String(ADMIN_PORT)}` },
    adminDir,
    path.join(logs, 'preview.log'),
  );
  await waitFor(`${ADMIN_ORIGIN}/`);

  return async () => {
    web.kill('SIGTERM');
    server.kill('SIGTERM');
    idpProcess.kill('SIGTERM');
    await Promise.all([exited(web), exited(server), exited(idpProcess)]);
  };
}
