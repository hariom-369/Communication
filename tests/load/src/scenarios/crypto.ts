import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Context } from '../cli.js';
import type { HeadlessCommand, HeadlessEvent } from '../headless/worker.js';
import { Counters, Histogram } from '../metrics.js';
import { seed } from '../seed.js';

/**
 * Real end-to-end encryption under load (docs/load-testing.md §2): `--pairs` pairs of headless
 * clients — the web app's own messaging and encryption code, real MLS through the real API —
 * register their devices, open direct conversations (KeyPackage claim, group creation,
 * Welcome) and message each other at `--pair-rate` per second each way, while the synthetic
 * accounts send `--rate` messages per second in the background. Measures device registration,
 * conversation setup, end-to-end latency including encryption and decryption, and checks that
 * every message arrives once, in order.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

interface Client {
  readonly worker: Worker;
  readonly username: string;
  readonly userId: string;
  send(command: HeadlessCommand): void;
  next(kind: HeadlessEvent['event'], timeoutMs: number): Promise<HeadlessEvent>;
}

export async function crypto(context: Context): Promise<Record<string, unknown>> {
  const { options, stack, log } = context;
  const counters = new Counters();
  const registration = new Histogram();
  const setup = new Histogram();
  const latency = new Histogram();
  /** Highest message number seen per (conversation, sender). */
  const lastSeen = new Map<string, number>();

  await context.all({ cmd: 'connect', rate: options.connectRate });
  const bulk = await context.report(true);
  log(`background: ${String(bulk.connected)} sockets, ${String(options.rate)} msg/s`);
  context.monitor.start();
  const durationMs = options.durationS * 1000;
  const background = context.all({
    cmd: 'send',
    rate: options.rate,
    durationMs: durationMs + 30_000,
    kind: 'direct',
    payloadBytes: options.payloadBytes,
  });
  // Awaited at the end; a failure must not surface earlier as an unhandled rejection.
  background.catch(() => undefined);

  const accounts = await seed({
    databaseUrl: stack.databaseUrl,
    users: options.pairs * 2,
    devices: false,
    prefix: 'mls',
  });
  const clients: Client[] = accounts.users.map((user, i) => {
    const worker = new Worker(path.join(here, 'headless-worker.js'), {
      // A runaway client stops alone instead of taking the coordinator down.
      resourceLimits: { maxOldGenerationSizeMb: 768 },
      workerData: {
        userId: user.id,
        username: user.username,
        token: user.token,
        api: stack.endpoints.api[i % stack.endpoints.api.length],
        realtime: stack.endpoints.realtime[i % stack.endpoints.realtime.length],
        origin: stack.endpoints.origin,
        // Away from the generators' addresses (sourceAddresses(…) offsets 0–999).
        localAddress: `127.0.200.${String(i + 1)}`,
      },
    });
    const waiting: { kind: string; resolve: (e: HeadlessEvent) => void }[] = [];
    worker.on('message', (event: HeadlessEvent) => {
      if (event.event === 'received') {
        counters.add('received');
        latency.record(event.latencyMs);
        const key = `${event.conversationId}:${event.from}`;
        const previous = lastSeen.get(key) ?? -1;
        if (event.n === previous + 1) counters.add('in_order');
        else if (event.n <= previous) counters.add('duplicate_or_reordered');
        else counters.add('gap');
        lastSeen.set(key, Math.max(previous, event.n));
        return;
      }
      if (event.event === 'diagnostic') {
        log(`client ${user.username}: ${event.message}`);
        return;
      }
      if (event.event === 'error') {
        counters.add('client_error');
        log(`client ${user.username}: ${event.message}`);
      }
      const index = waiting.findIndex((w) => w.kind === event.event);
      if (index >= 0) waiting.splice(index, 1)[0]?.resolve(event);
    });
    worker.on('error', (error) => {
      counters.add('worker_crashed');
      log(`worker ${user.username} crashed: ${error.message}`);
    });
    return {
      worker,
      username: user.username,
      userId: user.id,
      send: (command) => worker.postMessage(command),
      next: (kind, timeoutMs) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timeout waiting for ${kind}`)),
            timeoutMs,
          );
          waiting.push({
            kind,
            resolve: (event) => {
              clearTimeout(timer);
              resolve(event);
            },
          });
        }),
    };
  });

  log(`starting ${String(clients.length)} headless clients (device registration)`);
  await Promise.all(
    clients.map(async (client) => {
      const ready = client.next('ready', 120_000);
      client.send({ cmd: 'start' });
      const event = await ready;
      if (event.event === 'ready') registration.record(event.ms);
    }),
  );
  log('opening conversations (KeyPackage claim, MLS group, Welcome)');
  const pairs: { a: Client; b: Client; conversationId: string }[] = [];
  for (let i = 0; i + 1 < clients.length; i += 2) {
    const a = clients[i];
    const b = clients[i + 1];
    if (a === undefined || b === undefined) continue;
    const opened = a.next('opened', 60_000);
    a.send({ cmd: 'open', peer: b.username });
    const event = await opened;
    if (event.event !== 'opened') continue;
    // The peer may send only once its client knows the conversation (Welcome processed).
    const joined = b.next('joined', 60_000);
    b.send({ cmd: 'join', conversationId: event.conversationId });
    const join = await joined;
    if (join.event !== 'joined') continue;
    setup.record(event.ms + join.ms);
    pairs.push({ a, b, conversationId: event.conversationId });
  }

  log(`messaging: ${String(pairs.length)} pairs × ${String(options.pairRate)} msg/s each way`);
  const sent = new Map<Client, number>();
  const started = Date.now();
  const stepMs = 1000 / options.pairRate;
  for (let step = 0; Date.now() - started < durationMs; step += 1) {
    const wait = started + step * stepMs - Date.now();
    if (wait > 0) await context.sleep(wait);
    for (const pair of pairs)
      for (const client of [pair.a, pair.b]) {
        const n = sent.get(client) ?? 0;
        client.send({ cmd: 'send', conversationId: pair.conversationId, n });
        sent.set(client, n + 1);
      }
  }
  await context.sleep(10_000); // last deliveries
  const totalSent = [...sent.values()].reduce((a, b) => a + b, 0);
  for (const client of clients) client.send({ cmd: 'stop' });
  await background;
  const resources = context.monitor.stop();
  const report = await context.report(false);
  return {
    pairs: pairs.length,
    perPairPerSecond: options.pairRate,
    background: {
      sockets: bulk.connected,
      targetPerSecond: options.rate,
      sendLatencyMs: report.send,
      deliveryLatencyMs: report.delivery,
    },
    deviceRegistrationMs: registration.summary(),
    conversationSetupMs: setup.summary(),
    endToEndLatencyMs: latency.summary(),
    messages: {
      sent: totalSent,
      received: counters.get('received'),
      inOrder: counters.get('in_order'),
      gaps: counters.get('gap'),
      duplicatesOrReordered: counters.get('duplicate_or_reordered'),
    },
    clientErrors: counters.get('client_error'),
    counters: Object.fromEntries(counters.values),
    resources,
  };
}
