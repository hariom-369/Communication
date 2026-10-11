import { VirtualUser, type Endpoints, type UserMetrics } from './client.js';
import { Counters, Histogram, schedule, type HistogramData } from './metrics.js';
import type { SeededUser } from './seed.js';

/**
 * One load-generator process (forked by cli.ts). Each holds a slice of the virtual users —
 * several processes are needed because a process may hold at most ~20,000 file descriptors
 * here — and runs commands from the coordinator over IPC.
 */

export interface GeneratorConversation {
  readonly id: string;
  readonly kind: 'direct' | 'group';
  /** Local users (indexes into this generator's `users`) who send in it. */
  readonly senders: readonly number[];
}

export type Command =
  | {
      readonly cmd: 'init';
      readonly users: readonly SeededUser[];
      readonly conversations: readonly GeneratorConversation[];
      readonly endpoints: Endpoints;
      readonly addresses: readonly string[];
      readonly offset: number;
    }
  | { readonly cmd: 'connect'; readonly rate: number; readonly only?: number }
  | {
      readonly cmd: 'send';
      readonly rate: number;
      readonly durationMs: number;
      readonly kind: 'direct' | 'group';
      readonly payloadBytes: number;
    }
  | {
      /** Requests from random local users; `{conversation}` and `{channel}` are filled in. */
      readonly cmd: 'http';
      readonly rate: number;
      readonly durationMs: number;
      readonly method: 'GET' | 'POST';
      readonly path: string;
      readonly body?: unknown;
      readonly channel?: string;
    }
  | {
      /** 1:1 call setups: ICE, start, ring on the callee's socket, join, hold, leave. */
      readonly cmd: 'calls';
      readonly rate: number;
      readonly durationMs: number;
      readonly holdMs: number;
    }
  | { readonly cmd: 'report'; readonly reset: boolean }
  | { readonly cmd: 'reconnect'; readonly enabled: boolean }
  | { readonly cmd: 'close' };

export interface Report {
  readonly connected: number;
  readonly states: Record<string, number>;
  readonly http: HistogramData;
  readonly ring: HistogramData;
  readonly setup: HistogramData;
  readonly connect: HistogramData;
  readonly reconnect: HistogramData;
  readonly delivery: HistogramData;
  readonly send: HistogramData;
  readonly counters: [string, number][];
}

const extra = { http: new Histogram(), ring: new Histogram(), setup: new Histogram() };

const metrics: UserMetrics = {
  connect: new Histogram(),
  reconnect: new Histogram(),
  delivery: new Histogram(),
  send: new Histogram(),
  counters: new Counters(),
};

let users: VirtualUser[] = [];
let conversations: readonly GeneratorConversation[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `task` at the scheduled offsets without waiting for earlier ones (open loop). */
async function openLoop(offsets: readonly number[], task: (i: number) => Promise<void>) {
  const started = Date.now();
  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const wait = started + (offsets[i] ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    inFlight.push(task(i).catch(() => undefined));
  }
  await Promise.all(inFlight);
}

function resetMetrics(): void {
  for (const key of ['connect', 'reconnect', 'delivery', 'send'] as const)
    Object.assign(metrics, { [key]: new Histogram() });
  Object.assign(metrics, { counters: new Counters() });
  extra.http = new Histogram();
  extra.ring = new Histogram();
  extra.setup = new Histogram();
}

function fill(template: string, conversation: string, channel: string): string {
  return template.replaceAll('{conversation}', conversation).replaceAll('{channel}', channel);
}

/** A local user and one of its direct conversations (both members are local). */
function randomPair(): {
  conversation: GeneratorConversation;
  caller: VirtualUser;
  callee: VirtualUser;
} | null {
  const pool = conversations.filter((c) => c.kind === 'direct' && c.senders.length === 2);
  const conversation = pool[Math.floor(Math.random() * pool.length)];
  if (conversation === undefined) return null;
  const caller = users[conversation.senders[0] ?? 0];
  const callee = users[conversation.senders[1] ?? 0];
  return caller === undefined || callee === undefined ? null : { conversation, caller, callee };
}

/** Calls being set up: conversation → when the caller started and who should ring. */
const ringing = new Map<string, { started: number; callee: string }>();

async function handle(command: Command): Promise<unknown> {
  switch (command.cmd) {
    case 'init': {
      users = command.users.map(
        (user, i) =>
          new VirtualUser(
            user,
            {
              api: command.endpoints.api[(command.offset + i) % command.endpoints.api.length] ?? '',
              realtime: command.endpoints.realtime,
              pod: command.offset + i,
              origin: command.endpoints.origin,
            },
            command.addresses[i % command.addresses.length] ?? '127.0.0.1',
            metrics,
          ),
      );
      conversations = command.conversations;
      return { users: users.length };
    }
    case 'connect': {
      const targets = users
        .filter((user) => !user.connected)
        .slice(0, command.only ?? users.length);
      await openLoop(schedule(command.rate, (targets.length / command.rate) * 1000), async (i) => {
        const user = targets[i];
        if (user === undefined) return;
        try {
          await user.connect();
        } catch {
          metrics.counters.add('connect_failed');
        }
      });
      return { connected: users.filter((user) => user.connected).length };
    }
    case 'send': {
      const pool = conversations.filter((c) => c.kind === command.kind && c.senders.length > 0);
      if (pool.length === 0) return { sent: 0 };
      await openLoop(schedule(command.rate, command.durationMs), async () => {
        const conversation = pool[Math.floor(Math.random() * pool.length)];
        if (conversation === undefined) return;
        const sender =
          users[conversation.senders[Math.floor(Math.random() * conversation.senders.length)] ?? 0];
        if (sender === undefined) return;
        try {
          await sender.send(conversation.id, command.payloadBytes);
        } catch {
          metrics.counters.add('send_error');
        }
      });
      return { sent: metrics.counters.get('sent') };
    }
    case 'http': {
      await openLoop(schedule(command.rate, command.durationMs), async () => {
        const pair = randomPair();
        if (pair === null) return;
        const path = fill(command.path, pair.conversation.id, command.channel ?? '');
        const body =
          command.body === undefined
            ? undefined
            : JSON.parse(
                fill(JSON.stringify(command.body), pair.conversation.id, command.channel ?? ''),
              );
        const started = Date.now();
        try {
          // Either member (users alternate between API processes by index).
          const who = Math.random() < 0.5 ? pair.caller : pair.callee;
          const response = await who.request(command.method, path, body);
          extra.http.record(Date.now() - started);
          metrics.counters.add(`http_${String(response.status)}`);
        } catch {
          metrics.counters.add('http_error');
        }
      });
      return {};
    }
    case 'calls': {
      for (const user of users)
        user.onEvent = (frame) => {
          if (frame['type'] !== 'call' || frame['state'] !== 'ringing') return;
          const pending = ringing.get(String(frame['conversationId']));
          if (pending === undefined || pending.callee !== user.user.id) return;
          extra.ring.record(Date.now() - pending.started);
          metrics.counters.add('ring_delivered');
        };
      await openLoop(schedule(command.rate, command.durationMs), async () => {
        const pair = randomPair();
        if (pair === null || ringing.has(pair.conversation.id)) {
          metrics.counters.add('skipped_already_in_call');
          return;
        }
        const started = Date.now();
        ringing.set(pair.conversation.id, { started, callee: pair.callee.user.id });
        try {
          const ice = await pair.caller.request('POST', '/api/v1/calls/ice', {});
          metrics.counters.add(`ice_${String(ice.status)}`);
          const start = await pair.caller.request('POST', '/api/v1/calls', {
            conversationId: pair.conversation.id,
            media: 'audio',
            deviceId: pair.caller.user.deviceId,
          });
          metrics.counters.add(`start_${String(start.status)}`);
          const callId = (start.body as { call?: { id?: string } }).call?.id;
          if (callId === undefined) return;
          const join = await pair.callee.request('POST', `/api/v1/calls/${callId}/join`, {
            deviceId: pair.callee.user.deviceId,
          });
          metrics.counters.add(`join_${String(join.status)}`);
          if (join.status === 200) extra.setup.record(Date.now() - started);
          await sleep(command.holdMs);
          for (const side of [pair.caller, pair.callee]) {
            const leave = await side.request('POST', `/api/v1/calls/${callId}/leave`, {
              deviceId: side.user.deviceId,
              reason: 'hangup',
            });
            metrics.counters.add(`leave_${String(leave.status)}`);
          }
        } catch {
          metrics.counters.add('call_error');
        } finally {
          ringing.delete(pair.conversation.id);
        }
      });
      return {};
    }
    case 'report': {
      const states: Record<string, number> = {};
      for (const user of users) states[user.state] = (states[user.state] ?? 0) + 1;
      const report: Report = {
        connected: users.filter((user) => user.connected).length,
        states,
        http: extra.http.toData(),
        ring: extra.ring.toData(),
        setup: extra.setup.toData(),
        connect: metrics.connect.toData(),
        reconnect: metrics.reconnect.toData(),
        delivery: metrics.delivery.toData(),
        send: metrics.send.toData(),
        counters: metrics.counters.toData(),
      };
      if (command.reset) resetMetrics();
      return report;
    }
    case 'reconnect':
      for (const user of users) user.reconnect = command.enabled;
      return {};
    case 'close':
      for (const user of users) user.close();
      setTimeout(() => process.exit(0), 200);
      return {};
  }
}

process.on('message', (message: { id: number; command: Command }) => {
  handle(message.command).then(
    (result) => process.send?.({ id: message.id, ok: true, result }),
    (error: unknown) => process.send?.({ id: message.id, ok: false, error: String(error) }),
  );
});
process.send?.({ id: 0, ok: true, result: 'ready' });
