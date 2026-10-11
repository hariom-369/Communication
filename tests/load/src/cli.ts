import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { sourceAddresses } from './client.js';
import type { Command, GeneratorConversation, Report } from './generator.js';
import { Counters, Histogram, ResourceMonitor, type LatencySummary } from './metrics.js';
import { calls } from './scenarios/calls.js';
import { channel } from './scenarios/channel.js';
import { crypto } from './scenarios/crypto.js';
import { group } from './scenarios/group.js';
import { steady } from './scenarios/steady.js';
import { storm } from './scenarios/storm.js';
import { seed, type Seed } from './seed.js';
import { startStack, type Stack } from './stack.js';

/**
 * Load-test coordinator (docs/load-testing.md):
 *
 *   node dist/cli.js <steady|storm|group|channel|calls|crypto> [options]
 *
 * Starts the services from their production builds, seeds accounts, forks generator processes,
 * runs the scenario and writes a JSON result (and a one-screen summary).
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Options {
  readonly users: number;
  readonly generators: number;
  readonly apis: number;
  readonly realtimes: number;
  /** Messages (or operations) per second, all generators together. */
  readonly rate: number;
  readonly durationS: number;
  readonly warmupS: number;
  readonly payloadBytes: number;
  readonly connectRate: number;
  readonly groupSize: number;
  /** Channel scenario: synthetic subscribers on top of the seeded accounts. */
  readonly subscribers: number;
  /** Calls scenario: how long each call lasts. */
  readonly holdS: number;
  /** Crypto scenario: headless pairs, and messages per second per pair. */
  readonly pairs: number;
  readonly pairRate: number;
  readonly mode: string;
  readonly out: string;
  readonly apiEnv: Record<string, string>;
  readonly realtimeEnv: Record<string, string>;
}

export interface Generator {
  readonly child: ChildProcess;
  call(command: Command): Promise<unknown>;
}

export interface Context {
  readonly options: Options;
  readonly stack: Stack;
  readonly seed: Seed;
  readonly generators: readonly Generator[];
  readonly monitor: ResourceMonitor;
  /** Sends a command to every generator; rates are split evenly. */
  all(command: Command): Promise<unknown[]>;
  report(reset: boolean): Promise<MergedReport>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface MergedReport {
  readonly connected: number;
  readonly states: Record<string, number>;
  readonly connect: LatencySummary;
  readonly reconnect: LatencySummary;
  readonly delivery: LatencySummary;
  readonly send: LatencySummary;
  readonly http: LatencySummary;
  readonly ring: LatencySummary;
  readonly setup: LatencySummary;
  readonly counters: Record<string, number>;
}

function spawnGenerator(): Promise<Generator> {
  const child = fork(path.join(here, 'generator.js'), [], {
    execArgv: ['--max-old-space-size=3072'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  return new Promise((resolve, reject) => {
    child.on(
      'message',
      (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
        if (message.id === 0) {
          resolve({
            child,
            call: (command) =>
              new Promise((done, fail) => {
                const id = next++;
                pending.set(id, { resolve: done, reject: fail });
                child.send({ id, command });
              }),
          });
          return;
        }
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) entry?.resolve(message.result);
        else entry?.reject(new Error(message.error));
      },
    );
    child.once('exit', (code, signal) => {
      process.stderr.write(
        `generator ${String(child.pid)} exited (${String(code)} ${String(signal)})\n`,
      );
      reject(new Error(`generator exited ${String(code)}`));
      for (const entry of pending.values()) entry.reject(new Error('generator exited'));
    });
  });
}

function mergeReports(reports: readonly Report[]): MergedReport {
  const merged = {
    connect: new Histogram(),
    reconnect: new Histogram(),
    delivery: new Histogram(),
    send: new Histogram(),
    http: new Histogram(),
    ring: new Histogram(),
    setup: new Histogram(),
  };
  const counters = new Counters();
  const states = new Counters();
  let connected = 0;
  for (const report of reports) {
    connected += report.connected;
    states.merge(Object.entries(report.states));
    merged.connect.merge(report.connect);
    merged.reconnect.merge(report.reconnect);
    merged.delivery.merge(report.delivery);
    merged.send.merge(report.send);
    merged.http.merge(report.http);
    merged.ring.merge(report.ring);
    merged.setup.merge(report.setup);
    counters.merge(report.counters);
  }
  return {
    connected,
    states: Object.fromEntries(states.values),
    connect: merged.connect.summary(),
    reconnect: merged.reconnect.summary(),
    delivery: merged.delivery.summary(),
    send: merged.send.summary(),
    http: merged.http.summary(),
    ring: merged.ring.summary(),
    setup: merged.setup.summary(),
    counters: Object.fromEntries(counters.values),
  };
}

/** Splits users into contiguous, even-sized slices (a direct pair stays in one generator). */
function assign(data: Seed, generators: number) {
  const per = Math.ceil(data.users.length / generators / 2) * 2;
  return Array.from({ length: generators }, (_, g) => {
    const from = g * per;
    const to = Math.min(data.users.length, from + per);
    const conversations: GeneratorConversation[] = data.conversations.flatMap((c) => {
      const senders = c.members.filter((m) => m >= from && m < to).map((m) => m - from);
      return senders.length === 0
        ? []
        : [{ id: c.id, kind: c.kind, senders, members: c.members.length }];
    });
    return { from, to, users: data.users.slice(from, to), conversations };
  });
}

const SCENARIOS: Record<string, (context: Context) => Promise<Record<string, unknown>>> = {
  steady,
  storm,
  group,
  channel,
  calls,
  crypto,
};

function envPairs(values: readonly string[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (values ?? []).map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      users: { type: 'string', default: '2000' },
      generators: { type: 'string', default: '2' },
      apis: { type: 'string', default: '1' },
      realtimes: { type: 'string', default: '1' },
      rate: { type: 'string', default: '60' },
      duration: { type: 'string', default: '60' },
      warmup: { type: 'string', default: '15' },
      payload: { type: 'string', default: '512' },
      'connect-rate': { type: 'string', default: '400' },
      'group-size': { type: 'string', default: '1024' },
      subscribers: { type: 'string', default: '1000000' },
      hold: { type: 'string', default: '30' },
      pairs: { type: 'string', default: '10' },
      'pair-rate': { type: 'string', default: '0.5' },
      mode: { type: 'string', default: 'drain' },
      out: { type: 'string', default: path.join(here, '../results') },
      'api-env': { type: 'string', multiple: true },
      'realtime-env': { type: 'string', multiple: true },
    },
  });
  const scenarioName = positionals[0] ?? '';
  const scenario = SCENARIOS[scenarioName];
  if (scenario === undefined) {
    process.stderr.write(`usage: cli.js <${Object.keys(SCENARIOS).join('|')}> [options]\n`);
    process.exit(2);
  }
  const options: Options = {
    users: Number(values.users),
    generators: Number(values.generators),
    apis: Number(values.apis),
    realtimes: Number(values.realtimes),
    rate: Number(values.rate),
    durationS: Number(values.duration),
    warmupS: Number(values.warmup),
    payloadBytes: Number(values.payload),
    connectRate: Number(values['connect-rate']),
    groupSize: Number(values['group-size']),
    subscribers: Number(values.subscribers),
    holdS: Number(values.hold),
    pairs: Number(values.pairs),
    pairRate: Number(values['pair-rate']),
    mode: values.mode,
    out: values.out,
    apiEnv: envPairs(values['api-env']),
    realtimeEnv: envPairs(values['realtime-env']),
  };
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  const valkeyUrl = process.env['TEST_VALKEY_URL'];
  const s3Url = process.env['TEST_S3_URL'];
  if (databaseUrl === undefined || valkeyUrl === undefined || s3Url === undefined)
    throw new Error('Set TEST_DATABASE_URL, TEST_VALKEY_URL and TEST_S3_URL');
  const log = (message: string) =>
    process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);

  log(`starting ${String(options.apis)} API and ${String(options.realtimes)} realtime processes`);
  const stack = await startStack({
    databaseUrl,
    valkeyUrl,
    s3Url,
    apis: options.apis,
    realtimes: options.realtimes,
    apiEnv: options.apiEnv,
    realtimeEnv: options.realtimeEnv,
    logDir: path.join(options.out, 'logs'),
  });
  const generators: Generator[] = [];
  try {
    const groupSizes = scenarioName === 'group' ? [options.groupSize] : [];
    log(`seeding ${String(options.users)} accounts`);
    const seeded = await seed({ databaseUrl: stack.databaseUrl, users: options.users, groupSizes });
    for (let g = 0; g < options.generators; g += 1) generators.push(await spawnGenerator());
    const slices = assign(seeded, options.generators);
    await Promise.all(
      generators.map((generator, g) =>
        generator.call({
          cmd: 'init',
          users: slices[g]?.users ?? [],
          conversations: slices[g]?.conversations ?? [],
          endpoints: stack.endpoints,
          addresses: sourceAddresses(40, g * 40),
          offset: slices[g]?.from ?? 0,
        }),
      ),
    );
    const monitor = new ResourceMonitor([
      ...stack.processes.map((p) => ({ name: p.name, pid: p.child.pid ?? 0 })),
      ...generators.map((generator, g) => ({
        name: `generator-${String(g)}`,
        pid: generator.child.pid ?? 0,
      })),
      { name: 'postgres', comm: 'postgres' },
      { name: 'valkey', comm: 'redis-server' },
    ]);
    const split = (command: Command): Command =>
      'rate' in command ? { ...command, rate: command.rate / generators.length } : command;
    const context: Context = {
      options,
      stack,
      seed: seeded,
      generators,
      monitor,
      all: (command) => Promise.all(generators.map((g) => g.call(split(command)))),
      report: async (reset) =>
        mergeReports(
          (await Promise.all(generators.map((g) => g.call({ cmd: 'report', reset })))) as Report[],
        ),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
    };
    log(`running ${scenarioName}`);
    const result = await scenario(context);
    const record = {
      scenario: scenarioName,
      at: new Date().toISOString(),
      machine: {
        cores: (await import('node:os')).cpus().length,
        memoryGb: Math.round((await import('node:os')).totalmem() / 2 ** 30),
      },
      options: { ...options, out: undefined },
      ...result,
    };
    mkdirSync(options.out, { recursive: true });
    const file = path.join(options.out, `${scenarioName}-${record.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    log(`result: ${file}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    // Bounded: a generator or service that does not stop in time is killed.
    const within = <T>(promise: Promise<T>, ms: number) =>
      Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms).unref())]);
    await within(
      Promise.all(generators.map((g) => g.call({ cmd: 'close' }).catch(() => undefined))),
      10_000,
    );
    await within(
      Promise.all(
        generators.map((generator) =>
          generator.child.exitCode === null
            ? new Promise((resolve) => generator.child.once('exit', resolve))
            : Promise.resolve(),
        ),
      ),
      5000,
    );
    for (const generator of generators)
      if (generator.child.exitCode === null && generator.child.signalCode === null) {
        log(`generator ${String(generator.child.pid)} did not stop; killing it`);
        generator.child.kill('SIGKILL');
      }
    await within(stack.stop(), 40_000);
    for (const entry of stack.processes)
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        log(`${entry.name} did not stop; killing it`);
        entry.child.kill('SIGKILL');
      }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
