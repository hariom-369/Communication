import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { SMTPServer } from 'smtp-server';

/**
 * Starts the full stack for E2E tests:
 *   PostgreSQL database `tessera_e2e` (fresh, migrated) · Valkey (existing) · SMTP capture on
 *   127.0.0.1:28025 with an HTTP inbox on :28026 · API on :28080 · web preview on :4173 ·
 *   coturn on :23478 (infra/calls/turnserver.conf) · LiveKit SFU on :27880.
 * Every fixed port is below 32768, outside Linux's ephemeral range (32768–60999): a listener
 * there could find its port already taken by some process's outgoing connection (EADDRINUSE —
 * seen for the push stand-in on the old 58998 and the admin health port on 59092).
 * Requires TEST_DATABASE_URL, TEST_VALKEY_URL and TEST_S3_URL (S3-compatible store for encrypted
 * attachments), like the integration tests (never skipped).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SMTP_PORT = 28025;
export const INBOX_PORT = 28026;
const API_PORT = 28080;
export const TURN_PORT = 23478;
const SFU_PORT = 27880;
/** The stand-in for Stripe's and Razorpay's APIs and payment pages (billing.spec.ts). */
export const PAYMENTS_PORT = 28997;
/**
 * Billing against the payment stand-in, with credentials made up for this run (the stand-in
 * accepts and signs with the same ones; test-mode prefixes, refused in production).
 */
const randomSecret = () => randomBytes(18).toString('base64url');
const PAYMENTS_ENV = {
  STRIPE_SECRET_KEY: `sk_test_${randomSecret()}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${randomSecret()}`,
  STRIPE_PRICES: 'premium_monthly=price_premium_monthly,creator_monthly=price_creator_monthly',
  STRIPE_API_URL: `http://127.0.0.1:${String(PAYMENTS_PORT)}`,
  RAZORPAY_KEY_ID: `rzp_test_${randomBytes(6).toString('hex')}`,
  RAZORPAY_KEY_SECRET: randomSecret(),
  RAZORPAY_WEBHOOK_SECRET: randomSecret(),
  RAZORPAY_PLANS: 'premium_monthly=plan_premium_monthly,creator_monthly=plan_creator_monthly',
  RAZORPAY_API_URL: `http://127.0.0.1:${String(PAYMENTS_PORT)}`,
  BILLING_SELLER_NAME: 'Tessera Test Private Limited',
  BILLING_SELLER_ADDRESS: '1 Test Road, Bengaluru 560001',
  BILLING_SELLER_GSTIN: '29ABCDE1234F1Z5',
  BILLING_SELLER_STATE: 'KA',
};
/** The stand-in push service the API delivers to (notifications.spec.ts runs it). */
export const PUSH_PORT = 28998;

/** coturn and LiveKit binaries (CI installs both; locally they may live elsewhere). */
function binary(name: string, envName: string): string {
  const configured = process.env[envName];
  if (configured !== undefined && configured !== '') return configured;
  const local = path.join(process.env['HOME'] ?? '', '.local/bin', name);
  return existsSync(local) ? local : name;
}

/** SIGTERM, then SIGKILL if it has not exited within 10 s. */
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const { connect } = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

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

function startNginx(webDir: string): ChildProcess {
  const work = mkdtempSync(path.join(tmpdir(), 'tessera-nginx-'));
  // Started as root (CI containers), nginx's workers run as an unprivileged user that must be
  // able to buffer request bodies here.
  mkdirSync(path.join(work, 'tmp'), { mode: 0o777 });
  chmodSync(work, 0o755);
  chmodSync(path.join(work, 'tmp'), 0o777);
  const conf = path.join(work, 'nginx.conf');
  const rendered = spawnSync(
    'node',
    [
      path.join(ROOT, 'infra/images/nginx/render.mjs'),
      '--app=web',
      `--headers=${path.join(webDir, 'dist/security-headers.json')}`,
      `--root=${path.join(webDir, 'dist')}`,
      `--sfu-upstream=127.0.0.1:${SFU_PORT}`,
      `--proxy=/api/=127.0.0.1:${API_PORT}`,
      '--proxy=/rt/=127.0.0.1:28081',
      '--port=4173',
      '--health-port=28092',
      `--pid=${path.join(work, 'nginx.pid')}`,
      `--temp=${path.join(work, 'tmp')}`,
    ],
    { encoding: 'utf8' },
  );
  if (rendered.status !== 0) throw new Error(`nginx config: ${rendered.stderr}`);
  writeFileSync(conf, rendered.stdout);
  return start('nginx', ['-c', conf, '-e', 'stderr', '-g', 'daemon off;'], {}, webDir);
}

function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  logFile?: string,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Prefixed, so a message can be traced to the process that wrote it.
  const tag = `[${path.basename(args[0] ?? command)}] `;
  child.stderr.on('data', (chunk: Buffer) =>
    process.stderr.write(
      chunk
        .toString()
        .split('\n')
        .map((line) => (line === '' ? line : tag + line))
        .join('\n'),
    ),
  );
  // Always drain stdout: a full pipe would stall the process.
  if (logFile === undefined) child.stdout.resume();
  else child.stdout.pipe(createWriteStream(logFile));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null)
      process.stderr.write(`[e2e] ${path.basename(command)} exited with code ${code}\n`);
  });
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
  // E2E_DB_ROLES=1 runs the services as the least-privilege roles of ops/db/roles.sql
  // (migrator for migrations, app for the API, realtime for the gateway), as production does.
  const roles = process.env['E2E_DB_ROLES'] === '1';
  const urlAs = (role: string) => {
    if (!roles) return databaseUrl.toString();
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = '';
    return url.toString();
  };
  const applyRoles = () => {
    if (!roles) return;
    const result = spawnSync(
      'psql',
      [
        databaseUrl.toString(),
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        path.join(ROOT, 'ops/db/roles.sql'),
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`ops/db/roles.sql failed: ${result.stderr}`);
  };
  applyRoles();

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

  // TURN relay: the production baseline, except that loopback peers are allowed — every browser
  // in this suite runs on 127.0.0.1. The deny-list itself is tested against the baseline in
  // services/api (turn-relay.integration.test.ts).
  const turnSecret = key();
  const turnPidFile = path.join(
    process.env['TMPDIR'] ?? '/tmp',
    `tessera-e2e-turn-${process.pid}.pid`,
  );
  const turnCommand = [
    binary('turnserver', 'TURNSERVER_BIN'),
    '-c',
    path.join(ROOT, 'infra/calls/turnserver.conf'),
    `--static-auth-secret=${turnSecret}`,
    `--listening-port=${TURN_PORT}`,
    '--listening-ip=127.0.0.1',
    '--relay-ip=127.0.0.1',
    '--allow-loopback-peers',
    '--allowed-peer-ip=127.0.0.1',
    '--no-tls',
    '--no-dtls',
    '--log-file=stdout',
    `--pidfile=${turnPidFile}`,
  ];
  const logs = process.env['TMPDIR'] ?? '/tmp';
  const turn = start(
    turnCommand[0] ?? 'turnserver',
    turnCommand.slice(1),
    {},
    ROOT,
    path.join(logs, 'tessera-e2e-turn.log'),
  );
  // The reconnect test replaces the relay mid-call (a network change for the call): it needs
  // the command line, and the pid file names whichever relay is running at teardown.
  process.env['E2E_TURN_COMMAND'] = JSON.stringify(turnCommand);
  process.env['E2E_TURN_PIDFILE'] = turnPidFile;
  // LiveKit SFU for group calls (dev settings; keys only for this run).
  const sfuKey = 'e2e';
  const sfuSecret = key();
  const sfu = start(
    binary('livekit-server', 'LIVEKIT_SERVER_BIN'),
    [
      '--config-body',
      [
        `port: ${SFU_PORT}`,
        'bind_addresses: ["127.0.0.1"]',
        'rtc:',
        `  tcp_port: ${SFU_PORT + 1}`,
        '  port_range_start: 20000',
        '  port_range_end: 20200',
        '  use_external_ip: false',
        '  node_ip: 127.0.0.1',
        'room:',
        '  empty_timeout: 30',
        'logging:',
        '  level: warn',
      ].join('\n'),
    ],
    { LIVEKIT_KEYS: `${sfuKey}: ${sfuSecret}` },
    ROOT,
    path.join(logs, 'tessera-e2e-sfu.log'),
  );
  await waitForPort(SFU_PORT);
  // Tests that inspect the SFU's view of a call mint their own tokens (calls.spec.ts).
  process.env['E2E_SFU_KEY'] = sfuKey;
  process.env['E2E_SFU_SECRET'] = sfuSecret;
  process.env['E2E_SFU_URL'] = `ws://127.0.0.1:${SFU_PORT}`;

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const vapid = {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    // 32 bytes exactly (a leading zero byte is dropped by getPrivateKey).
    privateKey: Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()])
      .subarray(-32)
      .toString('base64url'),
  };
  const moderationKey = createECDH('prime256v1');
  moderationKey.generateKeys();
  const apiEnv = {
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    HEALTH_PORT: '29090',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: urlAs('tessera_app'),
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
    TURN_URLS: `turn:127.0.0.1:${TURN_PORT}?transport=udp`,
    TURN_SHARED_SECRET: turnSecret,
    LIVEKIT_URL: '/sfu',
    LIVEKIT_API_URL: `http://127.0.0.1:${SFU_PORT}`,
    LIVEKIT_API_KEY: sfuKey,
    LIVEKIT_API_SECRET: sfuSecret,
    CALL_SWEEP_INTERVAL_MS: '2000',
    // Web Push: a fresh VAPID key pair per run; pushes go to the test push service.
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:e2e@tessera.localhost',
    PUSH_TEST_ENDPOINT_ORIGIN: `http://127.0.0.1:${PUSH_PORT}`,
    NOTIFY_INTERVAL_MS: '250',
    // Moderation: a fresh franking key ring and HPKE (P-256) key pair per run.
    FRANKING_KEYS: `f1:${key()}`,
    MODERATION_HPKE_PUBLIC_KEY: moderationKey.getPublicKey().toString('base64url'),
    MODERATION_HPKE_PRIVATE_KEY: moderationKey.getPrivateKey().toString('base64url'),
    // Billing against the payment-provider stand-in.
    ...PAYMENTS_ENV,
  };
  process.env['E2E_VAPID_PUBLIC_KEY'] = vapid.publicKey;
  // Test workers use it to reset the per-IP sign-up limit between spec files (support.ts).
  process.env['E2E_VALKEY_KEY_PREFIX'] = apiEnv.VALKEY_KEY_PREFIX;
  const apiDir = path.join(ROOT, 'services/api');
  const migrate = start(
    'node',
    ['dist/cli/migrate.js'],
    { ...apiEnv, DATABASE_URL: urlAs('tessera_migrator') },
    apiDir,
  );
  const migrateCode = await new Promise<number | null>((resolve) => migrate.on('exit', resolve));
  if (migrateCode !== 0) throw new Error('E2E database migration failed');
  applyRoles();

  const payments = start(
    'node',
    ['scripts/fake-payments.mjs'],
    {
      FAKE_PAYMENTS_PORT: String(PAYMENTS_PORT),
      FAKE_PAYMENTS_WEBHOOKS: `http://127.0.0.1:${String(API_PORT)}/api/v1/billing/webhooks`,
      FAKE_PAYMENTS_RETURN_URL: 'http://localhost:4173/settings/plan?checkout=return',
      ...PAYMENTS_ENV,
    },
    apiDir,
    path.join(logs, 'tessera-e2e-payments.log'),
  );
  await waitForPort(PAYMENTS_PORT);

  const api = start('node', ['dist/server.js'], apiEnv, apiDir);
  await waitFor('http://127.0.0.1:29090/readyz');

  const realtime = start(
    'node',
    ['dist/server.js'],
    {
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '28081',
      HEALTH_PORT: '29091',
      LOG_LEVEL: 'warn',
      DATABASE_URL: urlAs('tessera_realtime'),
      VALKEY_URL: valkeyUrl,
      VALKEY_KEY_PREFIX: apiEnv.VALKEY_KEY_PREFIX,
      ALLOWED_ORIGINS: 'http://localhost:4173',
      SHUTDOWN_DRAIN_MS: '0',
    },
    path.join(ROOT, 'services/realtime'),
  );
  await waitFor('http://127.0.0.1:29091/readyz');

  // The production build, exactly as deployed (strict CSP applied by `vite preview`).
  const webDir = path.join(ROOT, 'apps/web');
  if (!existsSync(path.join(webDir, 'dist', 'index.html'))) {
    throw new Error('Run `pnpm build` before the E2E tests.');
  }
  // E2E_WEB_SERVER=nginx serves the same build through the production web server's generated
  // configuration (infra/images/nginx) instead of `vite preview`. The build must then have been
  // made with TESSERA_MEDIA_ORIGIN set to the test store, since nginx sends the headers the build
  // wrote.
  const web =
    process.env['E2E_WEB_SERVER'] === 'nginx'
      ? startNginx(webDir)
      : start(
          'pnpm',
          ['exec', 'vite', 'preview', '--host', 'localhost'],
          {
            TESSERA_API_URL: `http://127.0.0.1:${API_PORT}`,
            TESSERA_REALTIME_URL: 'ws://127.0.0.1:28081',
            TESSERA_MEDIA_ORIGIN: s3.origin,
            TESSERA_SFU_URL: `ws://127.0.0.1:${SFU_PORT}`,
          },
          webDir,
        );
  await waitFor('http://localhost:4173/');

  return async () => {
    web.kill('SIGTERM');
    realtime.kill('SIGTERM');
    api.kill('SIGTERM');
    payments.kill('SIGTERM');
    // The next run binds the same ports: wait until the SFU and relay are really gone.
    await Promise.all([stop(sfu), stop(turn)]);
    try {
      process.kill(Number(readFileSync(turnPidFile, 'utf8').trim()), 'SIGTERM');
    } catch {
      // already stopped
    }
    await new Promise<void>((resolve) => inboxServer.close(() => resolve()));
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  };
}
