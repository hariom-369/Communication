import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, loadMigrations, migrate } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import { REALTIME_SUBPROTOCOL, userChannel, type RealtimeEvent } from '@tessera/validation';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { CloseCode, RealtimeGateway, type GatewayConfig } from './gateway.js';

const ORIGIN = 'https://app.tessera.test';
const API_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../api/migrations',
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(`Realtime integration tests need ${name} (see CONTRIBUTING.md).`);
  return value;
}

let admin: pg.Client;
let db: pg.Pool;
let dbName: string;
let valkey: Redis;
const prefix = `rt-it-${randomBytes(4).toString('hex')}`;
const logger = createLogger({
  service: 'rt-it',
  level: 'fatal',
  errorDetails: true,
  destination: new MemoryDestination(),
});

interface Node {
  gateway: RealtimeGateway;
  server: Server;
  subscriber: Redis;
  url: string;
}
const nodes: Node[] = [];

async function startNode(overrides: Partial<GatewayConfig> = {}): Promise<Node> {
  const subscriber = new Redis(requireEnv('TEST_VALKEY_URL'));
  const gateway = new RealtimeGateway({
    config: {
      allowedOrigins: [ORIGIN],
      path: '/rt/v1/ws',
      keyPrefix: prefix,
      maxConnections: 100,
      maxConnectionsPerUser: 5,
      heartbeatMs: 60_000,
      authTimeoutMs: 2_000,
      sessionRecheckMs: 60_000,
      ...overrides,
    },
    valkey,
    subscriber,
    db,
    logger,
  });
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const node = {
    gateway,
    server,
    subscriber,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/rt/v1/ws`,
  };
  nodes.push(node);
  return node;
}

beforeAll(async () => {
  const adminUrl = requireEnv('TEST_DATABASE_URL');
  dbName = `tessera_rt_${randomBytes(6).toString('hex')}`;
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  db = new pg.Pool({ connectionString: url.toString(), max: 5 });
  db.on('error', () => undefined);
  await migrate(db, await loadMigrations(API_MIGRATIONS), logger);
  valkey = new Redis(requireEnv('TEST_VALKEY_URL'));
});

afterEach(async () => {
  for (const node of nodes.splice(0)) {
    await node.gateway.drain(0);
    await new Promise<void>((resolve) =>
      node.server.close(() => {
        resolve();
      }),
    );
    node.subscriber.disconnect();
  }
});

afterAll(async () => {
  await db.end();
  valkey.disconnect();
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
});

async function createUser(): Promise<{ userId: string; sessionId: string }> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO users (id, username, status, accepted_terms_version, confirmed_adult_at) VALUES ($1, $2, 'active', 't', now())`,
    [userId, `rt_${userId.slice(0, 8)}`],
  );
  await db.query(
    `INSERT INTO sessions (id, user_id, token_digest, stage, idle_expires_at, expires_at, user_agent_summary, ip_prefix)
     VALUES ($1, $2, $3, 'active', now() + interval '1 day', now() + interval '1 day', 'test', 'test')`,
    [sessionId, userId, randomBytes(32)],
  );
  return { userId, sessionId };
}

async function createConversation(memberIds: string[]): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO conversations (id, kind, ciphersuite, created_by) VALUES ($1, 'direct', 0, $2)`,
    [id, memberIds[0]],
  );
  for (const member of memberIds) {
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
      [id, member],
    );
  }
  return id;
}

async function ticketFor(user: { userId: string; sessionId: string }): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await valkey.set(`${prefix}:rt:ticket:${ticket}`, JSON.stringify(user), 'EX', 30);
  return ticket;
}

interface TestSocket {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(frame: unknown): void;
}

function open(
  url: string,
  options: { origin?: string | null; protocol?: string; autoPong?: boolean } = {},
): Promise<TestSocket> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers['origin'] = options.origin ?? ORIGIN;
  const ws = new WebSocket(url, options.protocol ?? REALTIME_SUBPROTOCOL, {
    headers,
    autoPong: options.autoPong ?? true,
  });
  const frames: Record<string, unknown>[] = [];
  const waiters: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    const index = waiters.findIndex((waiter) => waiter.type === frame['type']);
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
    else frames.push(frame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        closed,
        send: (frame) => {
          ws.send(JSON.stringify(frame));
        },
        next: (type, timeoutMs = 3000) => {
          const buffered = frames.findIndex((frame) => frame['type'] === type);
          if (buffered >= 0) return Promise.resolve(frames.splice(buffered, 1)[0]!);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`No ${type} frame`));
            }, timeoutMs);
            waiters.push({
              type,
              resolve: (frame) => {
                clearTimeout(timer);
                res(frame);
              },
            });
          });
        },
      });
    });
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.on('error', reject);
  });
}

async function connect(
  url: string,
  user: { userId: string; sessionId: string },
): Promise<TestSocket> {
  const socket = await open(url);
  socket.send({ type: 'auth', id: 'a1', ticket: await ticketFor(user) });
  await socket.next('ready');
  return socket;
}

function publish(userId: string, event: RealtimeEvent): Promise<number> {
  return valkey.publish(userChannel(prefix, userId), JSON.stringify(event));
}

async function waitForSubscribers(userId: string, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const [, subscribers] = (await valkey.call(
      'PUBSUB',
      'NUMSUB',
      userChannel(prefix, userId),
    )) as [string, number];
    if (subscribers >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('subscription not established');
}

const sampleMessage = (seq: number) => ({
  seq,
  clientMessageId: randomUUID(),
  senderUserId: randomUUID(),
  epoch: 0,
  ciphertext: 'AAAA',
  serverTime: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1000).toISOString(),
});

describe('connection security', () => {
  it('rejects foreign or missing Origin headers before the WebSocket handshake (CSWSH)', async () => {
    const node = await startNode();
    await expect(open(node.url, { origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    await expect(open(node.url, { origin: null })).rejects.toThrow('HTTP 403');
  });

  it('rejects unknown paths and unsupported subprotocols', async () => {
    const node = await startNode();
    await expect(open(node.url.replace('/rt/v1/ws', '/other'))).rejects.toThrow('HTTP 404');
    await expect(open(node.url, { protocol: 'tessera.v0' })).rejects.toThrow();
  });

  it('closes unauthenticated sockets after the auth timeout', async () => {
    const node = await startNode({ authTimeoutMs: 150 });
    const socket = await open(node.url);
    expect((await socket.closed).code).toBe(CloseCode.unauthenticated);
  });

  it('requires authentication before any other frame', async () => {
    const node = await startNode();
    const socket = await open(node.url);
    socket.send({ type: 'ping', id: 'p' });
    expect((await socket.closed).code).toBe(CloseCode.unauthenticated);
  });

  it('accepts a ticket exactly once', async () => {
    const node = await startNode();
    const user = await createUser();
    const ticket = await ticketFor(user);
    const first = await open(node.url);
    first.send({ type: 'auth', id: '1', ticket });
    await first.next('ready');
    const replay = await open(node.url);
    replay.send({ type: 'auth', id: '1', ticket });
    expect((await replay.closed).code).toBe(CloseCode.unauthenticated);
    first.ws.close();
  });

  it('rejects tickets whose session has been revoked', async () => {
    const node = await startNode();
    const user = await createUser();
    const ticket = await ticketFor(user);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [user.sessionId]);
    const socket = await open(node.url);
    socket.send({ type: 'auth', id: '1', ticket });
    expect((await socket.closed).code).toBe(CloseCode.unauthenticated);
  });

  it('closes a user’s sockets whose session was revoked, keeping the others', async () => {
    const node = await startNode();
    const user = await createUser();
    const revoked = await connect(node.url, user);
    const otherSessionId = randomUUID();
    await db.query(
      `INSERT INTO sessions (id, user_id, token_digest, stage, idle_expires_at, expires_at, user_agent_summary, ip_prefix)
       VALUES ($1, $2, $3, 'active', now() + interval '1 day', now() + interval '1 day', 'test', 'test')`,
      [otherSessionId, user.userId, randomBytes(32)],
    );
    const kept = await connect(node.url, { userId: user.userId, sessionId: otherSessionId });
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [user.sessionId]);
    await publish(user.userId, { type: 'sessions_changed' });
    expect((await revoked.closed).code).toBe(CloseCode.forbidden);
    await publish(user.userId, { type: 'conversation', conversationId: randomUUID() });
    await kept.next('conversation');
    kept.ws.close();
  });

  it('limits connections per user', async () => {
    const node = await startNode({ maxConnectionsPerUser: 2 });
    const user = await createUser();
    const a = await connect(node.url, user);
    const b = await connect(node.url, user);
    const third = await open(node.url);
    third.send({ type: 'auth', id: '1', ticket: await ticketFor(user) });
    expect((await third.closed).code).toBe(CloseCode.tooManyConnections);
    a.ws.close();
    b.ws.close();
  });

  it('closes flooding clients and oversized frames', async () => {
    const node = await startNode();
    const user = await createUser();
    const flooder = await connect(node.url, user);
    for (let i = 0; i < 100; i++) flooder.send({ type: 'ping', id: String(i) });
    expect((await flooder.closed).code).toBe(CloseCode.rateLimited);

    const big = await connect(node.url, user);
    big.ws.send('x'.repeat(10_000));
    expect((await big.closed).code).toBe(1009); // message too big
  });

  it('terminates clients that stop answering pings', async () => {
    const node = await startNode({ heartbeatMs: 100 });
    const user = await createUser();
    const silent = await open(node.url, { autoPong: false });
    silent.send({ type: 'auth', id: '1', ticket: await ticketFor(user) });
    await silent.next('ready');
    expect((await silent.closed).code).toBe(1006); // terminated without a close frame
  });
});

describe('fan-out', () => {
  it('delivers a user’s events to all of their connections across nodes, and to nobody else', async () => {
    const nodeA = await startNode();
    const nodeB = await startNode();
    const alice = await createUser();
    const bob = await createUser();
    const aliceOnA = await connect(nodeA.url, alice);
    const aliceOnB = await connect(nodeB.url, alice);
    const bobOnA = await connect(nodeA.url, bob);
    await waitForSubscribers(alice.userId, 2);

    const conversationId = randomUUID();
    await publish(alice.userId, { type: 'message', conversationId, message: sampleMessage(7) });
    for (const socket of [aliceOnA, aliceOnB]) {
      const frame = await socket.next('message');
      expect(frame).toMatchObject({ conversationId, message: { seq: 7, ciphertext: 'AAAA' } });
    }
    await expect(bobOnA.next('message', 300)).rejects.toThrow();
    for (const socket of [aliceOnA, aliceOnB, bobOnA]) socket.ws.close();
  });

  it('ignores malformed events on the bus', async () => {
    const node = await startNode();
    const user = await createUser();
    const socket = await connect(node.url, user);
    await waitForSubscribers(user.userId, 1);
    await valkey.publish(userChannel(prefix, user.userId), '{"type":"message","conversationId":1}');
    await valkey.publish(userChannel(prefix, user.userId), 'not json');
    await publish(user.userId, { type: 'conversation', conversationId: randomUUID() });
    await socket.next('conversation');
    expect(socket.frames.filter((frame) => frame['type'] === 'message')).toEqual([]);
    socket.ws.close();
  });
});

describe('typing', () => {
  it('relays typing to other members only, and refuses non-members', async () => {
    const node = await startNode();
    const alice = await createUser();
    const bob = await createUser();
    const mallory = await createUser();
    const conversationId = await createConversation([alice.userId, bob.userId]);
    const aliceSocket = await connect(node.url, alice);
    const bobSocket = await connect(node.url, bob);
    const mallorySocket = await connect(node.url, mallory);

    aliceSocket.send({ type: 'typing', id: 't1', conversationId, state: 'start' });
    await aliceSocket.next('ack');
    expect(await bobSocket.next('typing')).toMatchObject({
      conversationId,
      userId: alice.userId,
      state: 'start',
    });
    await expect(aliceSocket.next('typing', 200)).rejects.toThrow();

    mallorySocket.send({ type: 'typing', id: 't2', conversationId, state: 'start' });
    expect(await mallorySocket.next('error')).toMatchObject({ id: 't2', code: 'NOT_FOUND' });
    for (const socket of [aliceSocket, bobSocket, mallorySocket]) socket.ws.close();
  });
});

describe('presence', () => {
  it('marks users online while connected and records last seen on disconnect', async () => {
    const node = await startNode();
    const user = await createUser();
    const socket = await connect(node.url, user);
    expect(await valkey.get(`${prefix}:presence:online:${user.userId}`)).toBe('1');
    socket.ws.close();
    await socket.closed;
    for (
      let i = 0;
      i < 50 && (await valkey.get(`${prefix}:presence:online:${user.userId}`)) !== null;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await valkey.get(`${prefix}:presence:online:${user.userId}`)).toBeNull();
    expect(Number(await valkey.get(`${prefix}:presence:seen:${user.userId}`))).toBeGreaterThan(
      Date.now() - 5000,
    );
  });
});

describe('draining', () => {
  it('asks clients to reconnect with jitter and then closes', async () => {
    const node = await startNode();
    const user = await createUser();
    const socket = await connect(node.url, user);
    const drained = node.gateway.drain(200);
    const hint = await socket.next('reconnect');
    expect(hint['afterMs']).toBeGreaterThanOrEqual(0);
    expect(hint['afterMs']).toBeLessThan(200);
    await drained;
    expect((await socket.closed).code).toBe(CloseCode.serviceRestart);
    nodes.splice(nodes.indexOf(node), 1);
    await new Promise<void>((resolve) =>
      node.server.close(() => {
        resolve();
      }),
    );
    node.subscriber.disconnect();
  });
});
