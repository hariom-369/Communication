import { spawn, type ChildProcess } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { Endpoints } from './client.js';

/**
 * Starts the services under test from their production builds (`pnpm build`): `apis` API
 * processes and `realtimes` realtime processes ("pods") on one PostgreSQL database and one
 * Valkey, configured as in production apart from secrets generated per run. Ports are below
 * 32768, outside Linux's ephemeral range, so outgoing connections of the generators can never
 * occupy them.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const ORIGIN = 'http://localhost:4173';
const API_PORT = 18080;
const REALTIME_PORT = 18180;
const HEALTH_PORT = 19080;

export interface StackOptions {
  /** Server holding the load database (TEST_DATABASE_URL). */
  readonly databaseUrl: string;
  readonly valkeyUrl: string;
  /** S3-compatible store (TEST_S3_URL); media is configured but not exercised. */
  readonly s3Url: string;
  readonly apis: number;
  readonly realtimes: number;
  /** Extra environment for every API process (tuning experiments). */
  readonly apiEnv?: Readonly<Record<string, string>>;
  readonly realtimeEnv?: Readonly<Record<string, string>>;
  readonly logDir: string;
}

export interface RunningProcess {
  readonly name: string;
  child: ChildProcess;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly healthUrl: string;
}

export interface Stack {
  readonly endpoints: Endpoints;
  readonly databaseUrl: string;
  readonly keyPrefix: string;
  readonly processes: RunningProcess[];
  /** SIGTERM a realtime process (it drains: reconnect hints), wait, start it again. */
  restart(name: string): Promise<{ drainedMs: number }>;
  stop(): Promise<void>;
}

function start(name: string, cwd: string, env: Record<string, string>, logDir: string) {
  const child = spawn('node', ['dist/server.js'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function waitReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`not ready: ${url}`);
}

/** Kills services a previous run left behind (e.g. when its coordinator was killed). */
function killLeftovers(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  for (const pid of readFileSync(pidFile, 'utf8').split('\n').map(Number).filter(Boolean)) {
    try {
      const command = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
      if (command.includes('dist/server.js')) process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

async function assertFree(url: string): Promise<void> {
  try {
    await fetch(url);
  } catch {
    return; // nothing listening: free
  }
  throw new Error(`${url} already answers: another stack is running (stop it first)`);
}

export async function startStack(options: StackOptions): Promise<Stack> {
  mkdirSync(options.logDir, { recursive: true });
  const pidFile = path.join(options.logDir, 'stack.pids');
  killLeftovers(pidFile);
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let i = 0; i < options.apis; i += 1)
    await assertFree(`http://127.0.0.1:${String(HEALTH_PORT + i)}/readyz`);
  for (let i = 0; i < options.realtimes; i += 1)
    await assertFree(`http://127.0.0.1:${String(HEALTH_PORT + 100 + i)}/readyz`);
  const name = 'tessera_load';
  const admin = new pg.Client({ connectionString: options.databaseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const databaseUrl = new URL(options.databaseUrl);
  databaseUrl.pathname = `/${name}`;
  const key = () => randomBytes(32).toString('base64');
  const bucket = `tessera-load-${Date.now().toString(36)}`;
  // Web Push enabled as in production (no subscriptions exist, so nothing is sent).
  const vapid = createECDH('prime256v1');
  vapid.generateKeys();
  await fetch(new URL(`/${bucket}`, options.s3Url), { method: 'PUT' });
  const keyPrefix = `load-${Date.now().toString(36)}`;
  const apiDir = path.join(ROOT, 'services/api');
  const realtimeDir = path.join(ROOT, 'services/realtime');
  const shared = {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl.toString(),
    VALKEY_URL: options.valkeyUrl,
    VALKEY_KEY_PREFIX: keyPrefix,
    ALLOWED_ORIGINS: ORIGIN,
  };
  const apiEnv = {
    ...shared,
    PUBLIC_WEB_URL: ORIGIN,
    SMTP_URL: 'smtp://127.0.0.1:2?ignoreTLS=true', // nothing is mailed during the scenarios
    EMAIL_FROM: 'Tessera <no-reply@tessera.localhost>',
    PASSWORD_PEPPER: `p1:${key()}`,
    SECRET_BOX_KEYS: `k1:${key()}`,
    WEBAUTHN_RP_ID: 'localhost',
    FRANKING_KEYS: `f1:${key()}`,
    TURN_URLS: 'turn:127.0.0.1:3478?transport=udp',
    TURN_SHARED_SECRET: key(),
    LIVEKIT_URL: '/sfu',
    LIVEKIT_API_URL: 'http://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'load',
    LIVEKIT_API_SECRET: key(),
    VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()])
      .subarray(-32)
      .toString('base64url'),
    VAPID_SUBJECT: 'mailto:load@tessera.localhost',
    MEDIA_S3_BUCKET: bucket,
    MEDIA_S3_REGION: 'us-east-1',
    MEDIA_S3_ENDPOINT: new URL(options.s3Url).origin,
    MEDIA_S3_FORCE_PATH_STYLE: 'true',
    MEDIA_S3_ACCESS_KEY_ID: 'load',
    MEDIA_S3_SECRET_ACCESS_KEY: 'load',
    ...options.apiEnv,
  };

  const migrate = spawn('node', ['dist/cli/migrate.js'], {
    cwd: apiDir,
    env: { ...process.env, ...apiEnv },
    stdio: 'inherit',
  });
  const code = await new Promise<number | null>((resolve) => migrate.on('exit', resolve));
  if (code !== 0) throw new Error('migration failed');

  const processes: RunningProcess[] = [];
  const apis: string[] = [];
  for (let i = 0; i < options.apis; i += 1) {
    const env = {
      ...apiEnv,
      PORT: String(API_PORT + i),
      HEALTH_PORT: String(HEALTH_PORT + i),
    };
    const nameOf = `api-${String(i)}`;
    processes.push({
      name: nameOf,
      child: start(nameOf, apiDir, env, options.logDir),
      env,
      cwd: apiDir,
      healthUrl: `http://127.0.0.1:${String(HEALTH_PORT + i)}/readyz`,
    });
    apis.push(`http://127.0.0.1:${String(API_PORT + i)}`);
  }
  const realtimes: string[] = [];
  for (let i = 0; i < options.realtimes; i += 1) {
    const env = {
      ...shared,
      PORT: String(REALTIME_PORT + i),
      HEALTH_PORT: String(HEALTH_PORT + 100 + i),
      // One process may hold 20,000 file descriptors here; stay below it (docs/capacity.md).
      MAX_CONNECTIONS: '19000',
      ...options.realtimeEnv,
    };
    const nameOf = `realtime-${String(i)}`;
    processes.push({
      name: nameOf,
      child: start(nameOf, realtimeDir, env, options.logDir),
      env,
      cwd: realtimeDir,
      healthUrl: `http://127.0.0.1:${String(HEALTH_PORT + 100 + i)}/readyz`,
    });
    realtimes.push(`ws://127.0.0.1:${String(REALTIME_PORT + i)}`);
  }
  writeFileSync(pidFile, processes.map((p) => String(p.child.pid)).join('\n'));
  // A process that dies while starting fails the run instead of being waited for.
  const died = Promise.race(
    processes.map(
      (entry) =>
        new Promise<never>((_resolve, reject) =>
          entry.child.once('exit', (code) => {
            reject(new Error(`${entry.name} exited during start (${String(code)}); see its log`));
          }),
        ),
    ),
  );
  died.catch(() => undefined);
  await Promise.race([Promise.all(processes.map((entry) => waitReady(entry.healthUrl))), died]);

  return {
    endpoints: { api: apis, realtime: realtimes, origin: ORIGIN },
    databaseUrl: databaseUrl.toString(),
    keyPrefix,
    processes,
    async restart(target) {
      const entry = processes.find((p) => p.name === target);
      if (entry === undefined) throw new Error(`no process ${target}`);
      const started = Date.now();
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        const exited = new Promise((resolve) => entry.child.once('exit', resolve));
        entry.child.kill('SIGTERM');
        await exited;
      }
      const drainedMs = Date.now() - started;
      entry.child = start(entry.name, entry.cwd, entry.env, options.logDir);
      await waitReady(entry.healthUrl);
      return { drainedMs };
    },
    async stop() {
      await Promise.all(
        processes.map(
          (entry) =>
            new Promise<void>((resolve) => {
              if (entry.child.exitCode !== null) {
                resolve();
                return;
              }
              entry.child.once('exit', () => {
                resolve();
              });
              entry.child.kill('SIGTERM');
            }),
        ),
      );
    },
  };
}
