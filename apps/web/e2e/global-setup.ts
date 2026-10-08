import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { SMTPServer } from 'smtp-server';

/**
 * Starts the full stack for E2E tests:
 *   PostgreSQL database `tessera_e2e` (fresh, migrated) · Valkey (existing) · SMTP capture on
 *   127.0.0.1:58025 with an HTTP inbox on :58026 · API on :58080 · web preview on :4173.
 * Requires TEST_DATABASE_URL, TEST_VALKEY_URL and TEST_S3_URL (S3-compatible store for encrypted
 * attachments), like the integration tests (never skipped).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SMTP_PORT = 58025;
export const INBOX_PORT = 58026;
const API_PORT = 58080;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`E2E tests need ${name} (see CONTRIBUTING.md).`);
  }
  return value;
}

function decodeBody(raw: string): string {
  const separator = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, separator);
  const body = raw.slice(separator + 4);
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return body;
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

function start(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = required('TEST_DATABASE_URL');
  const valkeyUrl = required('TEST_VALKEY_URL');

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS tessera_e2e WITH (FORCE)');
  await admin.query('CREATE DATABASE tessera_e2e');
  await admin.end();
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = '/tessera_e2e';

  // SMTP capture + JSON inbox for tests.
  const inbox: { to: string; subject: string; text: string }[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      stream.on('end', () => {
        const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '';
        for (const recipient of session.envelope.rcptTo) {
          inbox.push({ to: recipient.address.toLowerCase(), subject, text: decodeBody(raw) });
        }
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(SMTP_PORT, '127.0.0.1', resolve));
  const inboxServer: Server = createServer((request, response) => {
    const to = new URL(request.url ?? '/', 'http://inbox').searchParams.get('to')?.toLowerCase();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(inbox.filter((message) => message.to === to)));
  });
  await new Promise<void>((resolve) => inboxServer.listen(INBOX_PORT, '127.0.0.1', resolve));

  // A fresh bucket per run on the S3-compatible test store, with CORS for the web origin so the
  // browser can PUT parts and GET attachments directly (docs/media.md §2). The test store
  // accepts these setup requests unsigned.
  const s3 = new URL(required('TEST_S3_URL'));
  const bucket = `tessera-e2e-${Date.now().toString(36)}`;
  const created = await fetch(new URL(`/${bucket}`, s3), { method: 'PUT' });
  if (!created.ok) throw new Error(`Could not create the E2E bucket (${created.status})`);
  const cors = `<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost:4173</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  process.env['E2E_MEDIA_BUCKET'] = bucket; // tests inspect stored ciphertext
  const corsSet = await fetch(new URL(`/${bucket}?cors`, s3), { method: 'PUT', body: cors });
  if (!corsSet.ok) throw new Error(`Could not configure E2E bucket CORS (${corsSet.status})`);

  const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const apiEnv = {
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    HEALTH_PORT: '59090',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl.toString(),
    VALKEY_URL: valkeyUrl,
    VALKEY_KEY_PREFIX: `e2e-${Date.now().toString(36)}`, // fresh rate-limit state per run
    ALLOWED_ORIGINS: 'http://localhost:4173',
    PUBLIC_WEB_URL: 'http://localhost:4173',
    SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}?ignoreTLS=true`,
    EMAIL_FROM: 'Tessera <no-reply@tessera.localhost>',
    PASSWORD_PEPPER: `p1:${key()}`,
    SECRET_BOX_KEYS: `k1:${key()}`,
    WEBAUTHN_RP_ID: 'localhost',
    TRUST_PROXY_HOPS: '1',
    // Every simulated user in the suite comes from 127.0.0.1; the per-address flood guard is
    // for real networks, so it is raised here (per-user route limits still apply).
    IP_FLOOD_LIMIT_PER_MINUTE: '20000',
    CHANNEL_SCHEDULER_INTERVAL_MS: '1000',
    SHUTDOWN_DRAIN_MS: '0',
    MEDIA_S3_BUCKET: bucket,
    MEDIA_S3_REGION: 'us-east-1',
    MEDIA_S3_ENDPOINT: s3.origin,
    MEDIA_S3_FORCE_PATH_STYLE: 'true',
    MEDIA_S3_ACCESS_KEY_ID: 'e2e',
    MEDIA_S3_SECRET_ACCESS_KEY: 'e2e',
  };
  // Test workers use it to reset the per-IP sign-up limit between spec files (support.ts).
  process.env['E2E_VALKEY_KEY_PREFIX'] = apiEnv.VALKEY_KEY_PREFIX;
  const apiDir = path.join(ROOT, 'services/api');
  const migrate = start('node', ['dist/cli/migrate.js'], apiEnv, apiDir);
  const migrateCode = await new Promise<number | null>((resolve) => migrate.on('exit', resolve));
  if (migrateCode !== 0) throw new Error('E2E database migration failed');

  const api = start('node', ['dist/server.js'], apiEnv, apiDir);
  await waitFor('http://127.0.0.1:59090/readyz');

  const realtime = start(
    'node',
    ['dist/server.js'],
    {
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '58081',
      HEALTH_PORT: '59091',
      LOG_LEVEL: 'warn',
      DATABASE_URL: databaseUrl.toString(),
      VALKEY_URL: valkeyUrl,
      VALKEY_KEY_PREFIX: apiEnv.VALKEY_KEY_PREFIX,
      ALLOWED_ORIGINS: 'http://localhost:4173',
      SHUTDOWN_DRAIN_MS: '0',
    },
    path.join(ROOT, 'services/realtime'),
  );
  await waitFor('http://127.0.0.1:59091/readyz');

  // The production build, exactly as deployed (strict CSP applied by `vite preview`).
  const webDir = path.join(ROOT, 'apps/web');
  if (!existsSync(path.join(webDir, 'dist', 'index.html'))) {
    throw new Error('Run `pnpm build` before the E2E tests.');
  }
  const web = start(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', 'localhost'],
    {
      TESSERA_API_URL: `http://127.0.0.1:${API_PORT}`,
      TESSERA_REALTIME_URL: 'ws://127.0.0.1:58081',
      TESSERA_MEDIA_ORIGIN: s3.origin,
    },
    webDir,
  );
  await waitFor('http://localhost:4173/');

  return async () => {
    web.kill('SIGTERM');
    realtime.kill('SIGTERM');
    api.kill('SIGTERM');
    await new Promise<void>((resolve) => inboxServer.close(() => resolve()));
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  };
}
