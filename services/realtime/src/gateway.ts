import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';

import type { Logger } from '@tessera/platform';
import {
  clientFrameSchema,
  MAX_CLIENT_FRAME_BYTES,
  REALTIME_SUBPROTOCOL,
  realtimeEventSchema,
  userChannel,
  type RealtimeEvent,
  type ServerFrame,
} from '@tessera/validation';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

/**
 * WebSocket gateway (docs/realtime.md). Stateless apart from open sockets:
 * - authentication: first frame carries a single-use ticket issued by the API (GETDEL in Valkey);
 * - CSWSH defence: the Origin header must be on the allow-list before the upgrade is accepted;
 * - fan-out: one Valkey pub/sub channel per user; this node subscribes to the channels of the
 *   users connected to it;
 * - liveness: WebSocket ping every heartbeat, terminate after a missed pong;
 * - backpressure: slow consumers (large send buffer) are disconnected and resync on reconnect;
 * - never handles message plaintext — `message` events carry client ciphertext only.
 */

export interface GatewayConfig {
  readonly allowedOrigins: readonly string[];
  readonly path: string;
  readonly keyPrefix: string;
  readonly maxConnections: number;
  readonly maxConnectionsPerUser: number;
  readonly heartbeatMs: number;
  readonly authTimeoutMs: number;
  readonly sessionRecheckMs: number;
}

export interface GatewayDeps {
  readonly config: GatewayConfig;
  /** Commands (GETDEL, SET, PUBLISH). */
  readonly valkey: Redis;
  /** Dedicated connection in subscriber mode. */
  readonly subscriber: Redis;
  readonly db: pg.Pool;
  readonly logger: Logger;
}

/** Application close codes (4000–4999). */
export const CloseCode = {
  unauthenticated: 4401,
  forbidden: 4403,
  tooManyConnections: 4429,
  protocolError: 4400,
  rateLimited: 4408,
  goingAway: 1001,
  tryAgainLater: 1013,
  serviceRestart: 1012,
} as const;

const BACKPRESSURE_BYTES = 1024 * 1024;
const FRAMES_PER_SECOND = 20;
const FRAME_BURST = 40;
const TYPING_INTERVAL_MS = 3000;
const MEMBERSHIP_CACHE_MS = 60_000;
const PRESENCE_TTL_SECONDS = 90;
const LAST_SEEN_TTL_SECONDS = 90 * 24 * 3600;

const ticketSchema = z.object({ userId: z.string(), sessionId: z.string() });

interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  userId: string | null;
  sessionId: string | null;
  alive: boolean;
  tokens: number;
  tokensUpdatedAt: number;
  readonly lastTyping: Map<string, number>;
  readonly membership: Map<string, { members: string[] | null; until: number }>;
}

export class RealtimeGateway {
  readonly #deps: GatewayDeps;
  readonly #server: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #byUser = new Map<string, Set<Connection>>();
  readonly #timers: NodeJS.Timeout[] = [];
  #draining = false;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#server = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_FRAME_BYTES,
      perMessageDeflate: false, // avoids compression side channels and CPU amplification
      handleProtocols: (protocols) =>
        protocols.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false,
    });
    deps.subscriber.on('message', (channel: string, payload: string) => {
      this.#onEvent(channel, payload);
    });
    this.#timers.push(setInterval(() => void this.#heartbeat(), deps.config.heartbeatMs));
    this.#timers.push(
      setInterval(() => void this.#recheckAllSessions(), deps.config.sessionRecheckMs),
    );
    for (const timer of this.#timers) timer.unref();
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Handles an HTTP upgrade request; rejects before the handshake whenever possible. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, reason: string) => {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
    };
    const path = (request.url ?? '').split('?')[0];
    if (path !== this.#deps.config.path) {
      reject(404, 'Not Found');
      return;
    }
    if (this.#draining) {
      reject(503, 'Service Unavailable');
      return;
    }
    const origin = request.headers.origin;
    if (origin === undefined || !this.#deps.config.allowedOrigins.includes(origin)) {
      this.#deps.logger.warn('realtime.origin_rejected', { ok: false });
      reject(403, 'Forbidden');
      return;
    }
    if (this.#connections.size >= this.#deps.config.maxConnections) {
      reject(503, 'Service Unavailable');
      return;
    }
    this.#server.handleUpgrade(request, socket, head, (ws) => {
      this.#accept(ws);
    });
  }

  #accept(socket: WebSocket): void {
    if (socket.protocol !== REALTIME_SUBPROTOCOL) {
      socket.close(CloseCode.protocolError, 'Unsupported subprotocol');
      return;
    }
    const connection: Connection = {
      id: randomUUID(),
      socket,
      userId: null,
      sessionId: null,
      alive: true,
      tokens: FRAME_BURST,
      tokensUpdatedAt: Date.now(),
      lastTyping: new Map(),
      membership: new Map(),
    };
    this.#connections.add(connection);
    const authTimer = setTimeout(() => {
      if (connection.userId === null)
        socket.close(CloseCode.unauthenticated, 'Authentication timeout');
    }, this.#deps.config.authTimeoutMs);

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      void this.#onFrame(connection, data, isBinary).catch((error: unknown) => {
        this.#deps.logger.error('realtime.frame_failed', this.#deps.logger.errorFields(error));
        this.#send(connection, {
          type: 'error',
          id: null,
          code: 'INTERNAL',
          message: 'Internal error',
        });
      });
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      void this.#remove(connection);
    });
    socket.on('error', () => {
      socket.terminate();
    });
  }

  async #onFrame(connection: Connection, data: RawData, isBinary: boolean): Promise<void> {
    if (!this.#takeToken(connection)) {
      connection.socket.close(CloseCode.rateLimited, 'Too many frames');
      return;
    }
    if (isBinary) {
      connection.socket.close(CloseCode.protocolError, 'Binary frames are not supported');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data));
    } catch {
      connection.socket.close(CloseCode.protocolError, 'Malformed frame');
      return;
    }
    const frame = clientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      const id =
        typeof (parsed as { id?: unknown }).id === 'string' ? (parsed as { id: string }).id : null;
      this.#send(connection, {
        type: 'error',
        id,
        code: 'INVALID_FRAME',
        message: 'Invalid frame',
      });
      return;
    }

    const value = frame.data;
    if (connection.userId === null) {
      if (value.type !== 'auth') {
        connection.socket.close(CloseCode.unauthenticated, 'Authenticate first');
        return;
      }
      await this.#authenticate(connection, value.ticket);
      return;
    }

    switch (value.type) {
      case 'auth':
        this.#send(connection, {
          type: 'error',
          id: value.id,
          code: 'ALREADY_AUTHENTICATED',
          message: 'Already authenticated',
        });
        return;
      case 'ping':
        await this.#markOnline(connection.userId, connection.sessionId);
        this.#send(connection, { type: 'ack', id: value.id });
        return;
      case 'typing':
        await this.#typing(connection, value.id, value.conversationId, value.state);
        return;
    }
  }

  async #authenticate(connection: Connection, ticket: string): Promise<void> {
    const { valkey, db, config, logger } = this.#deps;
    const raw = /^[A-Za-z0-9_-]{43}$/.test(ticket)
      ? await valkey.getdel(`${config.keyPrefix}:rt:ticket:${ticket}`)
      : null;
    const claims = raw === null ? null : ticketSchema.safeParse(JSON.parse(raw));
    if (
      claims === null ||
      !claims.success ||
      !(await this.#sessionsValid([claims.data.sessionId], db)).has(claims.data.sessionId)
    ) {
      logger.info('realtime.auth_failed', { ok: false });
      connection.socket.close(CloseCode.unauthenticated, 'Invalid ticket');
      return;
    }
    const { userId, sessionId } = claims.data;
    const existing = this.#byUser.get(userId) ?? new Set<Connection>();
    if (existing.size >= config.maxConnectionsPerUser) {
      connection.socket.close(CloseCode.tooManyConnections, 'Too many connections');
      return;
    }
    connection.userId = userId;
    connection.sessionId = sessionId;
    existing.add(connection);
    if (existing.size === 1) {
      this.#byUser.set(userId, existing);
      await this.#deps.subscriber.subscribe(userChannel(config.keyPrefix, userId));
    }
    await this.#markOnline(userId, sessionId);
    this.#send(connection, {
      type: 'ready',
      heartbeatSeconds: Math.round(config.heartbeatMs / 1000),
    });
  }

  async #typing(
    connection: Connection,
    frameId: string,
    conversationId: string,
    state: 'start' | 'stop',
  ): Promise<void> {
    const userId = connection.userId;
    if (userId === null) return;
    const now = Date.now();
    const last = connection.lastTyping.get(conversationId) ?? 0;
    if (state === 'start' && now - last < TYPING_INTERVAL_MS) {
      this.#send(connection, { type: 'ack', id: frameId }); // coalesced, not an error
      return;
    }
    const members = await this.#members(connection, conversationId);
    if (members === null) {
      this.#send(connection, {
        type: 'error',
        id: frameId,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      return;
    }
    connection.lastTyping.set(conversationId, now);
    const event: RealtimeEvent = { type: 'typing', conversationId, userId, state };
    const payload = JSON.stringify(event);
    const pipeline = this.#deps.valkey.pipeline();
    for (const member of members) {
      if (member !== userId)
        pipeline.publish(userChannel(this.#deps.config.keyPrefix, member), payload);
    }
    await pipeline.exec();
    this.#send(connection, { type: 'ack', id: frameId });
  }

  /**
   * Member ids of the conversation if the connection's user is a member, else null (cached).
   * Members who blocked the user, or whom the user blocked, are left out (docs/moderation.md §2).
   */
  async #members(connection: Connection, conversationId: string): Promise<string[] | null> {
    if (!/^[0-9a-f-]{36}$/.test(conversationId)) return null;
    const cached = connection.membership.get(conversationId);
    if (cached !== undefined && cached.until > Date.now()) return cached.members;
    const result = await this.#deps.db.query<{ user_id: string; blocked: boolean }>(
      `SELECT m.user_id,
              EXISTS (SELECT 1 FROM blocks b
                      WHERE (b.blocker_id = m.user_id AND b.blocked_id = $2)
                         OR (b.blocker_id = $2 AND b.blocked_id = m.user_id)) AS blocked
         FROM conversation_members m
        WHERE m.conversation_id = $1 AND m.left_at IS NULL`,
      [conversationId, connection.userId],
    );
    const isMember =
      connection.userId !== null && result.rows.some((row) => row.user_id === connection.userId);
    const members = isMember
      ? result.rows.filter((row) => !row.blocked).map((row) => row.user_id)
      : null;
    if (connection.membership.size > 500) connection.membership.clear(); // bound memory per socket
    connection.membership.set(conversationId, { members, until: Date.now() + MEMBERSHIP_CACHE_MS });
    return members;
  }

  #onEvent(channel: string, payload: string): void {
    const prefix = `${this.#deps.config.keyPrefix}:rt:user:`;
    if (!channel.startsWith(prefix)) return;
    const userId = channel.slice(prefix.length);
    const connections = this.#byUser.get(userId);
    if (connections === undefined) return;
    let event: RealtimeEvent;
    try {
      event = realtimeEventSchema.parse(JSON.parse(payload));
    } catch {
      this.#deps.logger.warn('realtime.invalid_event', { ok: false });
      return;
    }
    if (event.type === 'sessions_changed') {
      void this.#recheckSessions([...connections]);
      return;
    }
    for (const connection of connections) this.#send(connection, event);
  }

  #send(connection: Connection, frame: ServerFrame): void {
    const socket = connection.socket;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BACKPRESSURE_BYTES) {
      // Slow consumer: drop the connection; the client re-syncs from the mailbox on reconnect.
      socket.close(CloseCode.tryAgainLater, 'Slow consumer');
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  #takeToken(connection: Connection): boolean {
    const now = Date.now();
    const refill = ((now - connection.tokensUpdatedAt) / 1000) * FRAMES_PER_SECOND;
    connection.tokens = Math.min(FRAME_BURST, connection.tokens + refill);
    connection.tokensUpdatedAt = now;
    if (connection.tokens < 1) return false;
    connection.tokens -= 1;
    return true;
  }

  /**
   * Presence for the user, and for the session: notifications skip pushes to sessions with an
   * open connection (docs/notifications.md §2), since realtime already delivers to them.
   */
  async #markOnline(userId: string, sessionId: string | null): Promise<void> {
    const { valkey, config } = this.#deps;
    const multi = valkey.multi();
    if (sessionId !== null)
      multi.set(
        `${config.keyPrefix}:presence:session:${sessionId}`,
        '1',
        'EX',
        PRESENCE_TTL_SECONDS,
      );
    await multi
      .set(`${config.keyPrefix}:presence:online:${userId}`, '1', 'EX', PRESENCE_TTL_SECONDS)
      .set(
        `${config.keyPrefix}:presence:seen:${userId}`,
        String(Date.now()),
        'EX',
        LAST_SEEN_TTL_SECONDS,
      )
      .exec();
  }

  async #heartbeat(): Promise<void> {
    const online = new Set<string>();
    const sessions = new Set<string>();
    for (const connection of this.#connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
      if (connection.userId !== null) online.add(connection.userId);
      if (connection.sessionId !== null) sessions.add(connection.sessionId);
    }
    const { valkey, config } = this.#deps;
    const marks = [...online].map((userId) => this.#markOnline(userId, null));
    if (sessions.size > 0) {
      const multi = valkey.multi();
      for (const sessionId of sessions)
        multi.set(
          `${config.keyPrefix}:presence:session:${sessionId}`,
          '1',
          'EX',
          PRESENCE_TTL_SECONDS,
        );
      marks.push(multi.exec().then(() => undefined));
    }
    await Promise.all(marks).catch((error: unknown) => {
      this.#deps.logger.warn('realtime.presence_failed', this.#deps.logger.errorFields(error));
    });
  }

  async #recheckAllSessions(): Promise<void> {
    await this.#recheckSessions([...this.#connections]);
  }

  /** Closes connections whose session was revoked or expired. */
  async #recheckSessions(connections: Connection[]): Promise<void> {
    const authenticated = connections.flatMap((connection) =>
      connection.sessionId === null ? [] : [{ connection, sessionId: connection.sessionId }],
    );
    if (authenticated.length === 0) return;
    try {
      const valid = await this.#sessionsValid(
        authenticated.map((entry) => entry.sessionId),
        this.#deps.db,
      );
      for (const { connection, sessionId } of authenticated) {
        if (!valid.has(sessionId)) connection.socket.close(CloseCode.forbidden, 'Session ended');
      }
    } catch (error) {
      this.#deps.logger.warn(
        'realtime.session_recheck_failed',
        this.#deps.logger.errorFields(error),
      );
    }
  }

  async #sessionsValid(sessionIds: string[], db: pg.Pool): Promise<Set<string>> {
    const ids = sessionIds.filter((id) => /^[0-9a-f-]{36}$/.test(id));
    if (ids.length === 0) return new Set();
    const result = await db.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE id = ANY($1::uuid[]) AND stage = 'active' AND revoked_at IS NULL
         AND expires_at > now() AND idle_expires_at > now()`,
      [ids],
    );
    return new Set(result.rows.map((row) => row.id));
  }

  async #remove(connection: Connection): Promise<void> {
    this.#connections.delete(connection);
    const userId = connection.userId;
    if (userId === null) return;
    const connections = this.#byUser.get(userId);
    connections?.delete(connection);
    const sessionId = connection.sessionId;
    if (
      sessionId !== null &&
      ![...(connections ?? [])].some((other) => other.sessionId === sessionId)
    ) {
      const { valkey, config } = this.#deps;
      await valkey.del(`${config.keyPrefix}:presence:session:${sessionId}`).catch(() => 0);
    }
    if (connections?.size === 0) {
      this.#byUser.delete(userId);
      const { subscriber, valkey, config } = this.#deps;
      try {
        await subscriber.unsubscribe(userChannel(config.keyPrefix, userId));
        await valkey
          .multi()
          .del(`${config.keyPrefix}:presence:online:${userId}`)
          .set(
            `${config.keyPrefix}:presence:seen:${userId}`,
            String(Date.now()),
            'EX',
            LAST_SEEN_TTL_SECONDS,
          )
          .exec();
      } catch (error) {
        this.#deps.logger.warn('realtime.cleanup_failed', this.#deps.logger.errorFields(error));
      }
    }
  }

  /**
   * Graceful shutdown: refuse new connections, ask clients to reconnect after a random delay
   * (spreads the reconnect storm across the other pods), then close what remains.
   */
  async drain(maxWaitMs: number): Promise<void> {
    this.#draining = true;
    for (const timer of this.#timers) clearInterval(timer);
    for (const connection of this.#connections) {
      // Crypto-quality randomness is not needed for jitter; derive it from the connection id.
      const jitter = parseInt(connection.id.slice(0, 8), 16) % Math.max(1, maxWaitMs);
      this.#send(connection, { type: 'reconnect', afterMs: jitter });
    }
    const deadline = Date.now() + maxWaitMs;
    while (this.#connections.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const connection of this.#connections)
      connection.socket.close(CloseCode.serviceRestart, 'Server restarting');
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
