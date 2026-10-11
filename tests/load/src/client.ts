import { randomBytes } from 'node:crypto';
import http from 'node:http';

import { newId } from '@tessera/shared';
import { REALTIME_SUBPROTOCOL } from '@tessera/validation';
import WebSocket from 'ws';

import type { Counters, Histogram } from './metrics.js';
import type { SeededUser } from './seed.js';

/**
 * A virtual user speaking Tessera's public protocol exactly as the web app does — including
 * what the app does on its own: delivery acks (coalesced) and catch-up from the mailbox after
 * every reconnect. Session
 * cookie + CSRF header on every API call, a single-use ticket for the realtime socket, the
 * `tessera.v1` subprotocol, an `auth` frame, JSON frames. Messages carry random bytes of a
 * realistic ciphertext size (MLS-shaped, not encrypted — the server cannot tell); the first 8
 * bytes hold the send time, so any receiver on this machine can measure delivery latency.
 */

export interface Endpoints {
  /** API processes (as behind a load balancer: requests are spread across them). */
  readonly api: readonly string[];
  /** Realtime processes ("pods"); a user connects to one of them. */
  readonly realtime: readonly string[];
  /** Allowed web origin (Origin header). */
  readonly origin: string;
}

const agents = new Map<string, http.Agent>();

/** Keep-alive agent per local source address (each address has its own ephemeral ports). */
function agentFor(localAddress: string): http.Agent {
  let agent = agents.get(localAddress);
  if (agent === undefined) {
    agent = new http.Agent({ keepAlive: true, maxSockets: 32, localAddress });
    agents.set(localAddress, agent);
  }
  return agent;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export function apiRequest(
  baseUrl: string,
  localAddress: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  origin: string,
  body?: unknown,
): Promise<ApiResponse> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        agent: agentFor(localAddress),
        headers: {
          cookie: `__Host-tsid=${token}`,
          'x-tessera-csrf': '1',
          origin,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': payload.length }),
        },
        timeout: 30_000,
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on('data', (chunk: Buffer) => parts.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            // keep text
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** A ciphertext-sized payload whose first 8 bytes carry the send time (ms, float64). */
export function stampedPayload(bytes: number, at = Date.now()): string {
  const buffer = randomBytes(Math.max(16, bytes));
  buffer.writeDoubleBE(at, 0);
  return buffer.toString('base64');
}

/** The send time a stamped payload carries (NaN if it is not one). */
export function payloadStamp(base64: string): number {
  const head = Buffer.from(base64.slice(0, 12), 'base64');
  return head.length >= 8 ? head.readDoubleBE(0) : Number.NaN;
}

/** The web client's base delay; LOAD_BACKOFF_BASE_MS tries alternatives (docs/capacity.md §4). */
const BACKOFF_BASE_MS = Number(process.env['LOAD_BACKOFF_BASE_MS'] ?? '500');
const BACKOFF_CAP_MS = 30_000;
const STABLE_AFTER_MS = 60_000;
const ACK_DELAY_MS = 150;

/** A send this slow is counted in its 10 s window (counter `slow@<epoch seconds>`). */
export const SLOW_MS = 1000;
export const SLOW_PREFIX = 'slow@';

export interface UserMetrics {
  readonly connect: Histogram;
  readonly reconnect: Histogram;
  readonly delivery: Histogram;
  readonly send: Histogram;
  readonly counters: Counters;
}

export class VirtualUser {
  readonly user: SeededUser;
  readonly #api: string;
  /** Realtime pods; a reconnect moves on to the next one, as a load balancer would. */
  readonly #realtime: readonly string[];
  #pod: number;
  readonly #origin: string;
  readonly #localAddress: string;
  readonly #metrics: UserMetrics;
  #socket: WebSocket | null = null;
  #closing = false;
  /** Sockets this client closed itself (their close event must not trigger a reconnect). */
  readonly #planned = new WeakSet<WebSocket>();
  #disconnectedAt: number | null = null;
  #ready = false;
  /** Reconnect automatically when the server closes or asks (like the web client). */
  reconnect = true;
  #attempt = 0;
  #stableTimer: NodeJS.Timeout | null = null;
  /** Highest message sequence number seen per conversation (pushed or fetched). */
  readonly #seen = new Map<string, number>();
  /** Other server frames (e.g. `call`), for scenarios that wait for them. */
  onEvent: ((frame: { type: string; [key: string]: unknown }) => void) | null = null;

  constructor(
    user: SeededUser,
    endpoints: { api: string; realtime: readonly string[]; pod: number; origin: string },
    localAddress: string,
    metrics: UserMetrics,
  ) {
    this.user = user;
    this.#api = endpoints.api;
    this.#realtime = endpoints.realtime;
    this.#pod = endpoints.pod;
    this.#origin = endpoints.origin;
    this.#localAddress = localAddress;
    this.#metrics = metrics;
  }

  get connected(): boolean {
    return this.#ready;
  }

  /** `ready`, `connecting` (ticket or handshake in flight) or `waiting` (backoff before retrying). */
  get state(): 'ready' | 'connecting' | 'waiting' | 'idle' {
    if (this.#ready) return 'ready';
    if (this.#connecting) return 'connecting';
    return this.#waiting ? 'waiting' : 'idle';
  }
  #connecting = false;
  #waiting = false;

  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    return apiRequest(
      this.#api,
      this.#localAddress,
      this.user.token,
      method,
      path,
      this.#origin,
      body,
    );
  }

  /** Ticket → socket → `auth` → `ready`. Resolves once ready (or rejects). */
  /** One attempt at a time: a second call while one is in flight joins it. */
  connect(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#connecting = true;
    this.#inFlight = this.#connectOnce().finally(() => {
      this.#connecting = false;
      this.#inFlight = null;
    });
    return this.#inFlight;
  }
  #inFlight: Promise<void> | null = null;

  async #connectOnce(): Promise<void> {
    const started = Date.now();
    const ticket = await this.request('POST', '/api/v1/realtime/ticket', {});
    if (ticket.status !== 201) {
      this.#metrics.counters.add(`ticket_${String(ticket.status)}`);
      throw new Error(`ticket ${String(ticket.status)}`);
    }
    const { ticket: value, url } = ticket.body as { ticket: string; url: string };
    await new Promise<void>((resolve, reject) => {
      const pod = this.#realtime[this.#pod % this.#realtime.length] ?? '';
      const socket = new WebSocket(`${pod}${url}`, REALTIME_SUBPROTOCOL, {
        origin: this.#origin,
        localAddress: this.#localAddress,
        perMessageDeflate: false,
        handshakeTimeout: 30_000,
      });
      this.#socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.terminate();
          reject(new Error('ready timeout'));
        }
      }, 30_000);
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'auth', id: newId(), ticket: value }));
      });
      socket.on('message', (data: WebSocket.RawData) => {
        if (socket !== this.#socket) return; // a replaced socket
        const frame = JSON.parse(data.toString()) as {
          type: string;
          afterMs?: number;
          conversationId?: string;
          message?: { ciphertext: string; seq: number };
        };
        if (frame.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.#ready = true;
          // As the web client: the backoff resets once a connection has lasted a minute.
          this.#stableTimer = setTimeout(() => {
            this.#attempt = 0;
          }, STABLE_AFTER_MS);
          this.#stableTimer.unref();
          const elapsed = Date.now() - started;
          if (this.#disconnectedAt !== null) {
            this.#metrics.reconnect.record(Date.now() - this.#disconnectedAt);
            this.#disconnectedAt = null;
          } else this.#metrics.connect.record(elapsed);
          resolve();
          // Like the web client, every (re)connect catches up from the mailbox.
          this.#catchUp().catch(() => {
            this.#metrics.counters.add('catchup_error');
          });
          return;
        }
        this.#onFrame(frame);
      });
      socket.on('close', (code: number) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.#pod += 1; // try another pod next time
          reject(new Error(`closed ${String(code)}`));
        }
        // A socket closed on purpose, or one already replaced, says nothing about the current one
        // (its close can arrive after the replacement is ready).
        if (this.#closing || this.#planned.has(socket) || socket !== this.#socket) return;
        if (this.#stableTimer !== null) clearTimeout(this.#stableTimer);
        const wasReady = this.#ready;
        this.#ready = false;
        this.#metrics.counters.add(`close_${String(code)}`);
        if (wasReady) {
          this.#disconnectedAt ??= Date.now();
          this.#pod += 1;
        }
        if (this.reconnect && wasReady) this.#scheduleReconnect(this.#backoff());
      });
      socket.on('error', () => {
        this.#metrics.counters.add('socket_error');
      });
      socket.on('unexpected-response', (_request, response) => {
        this.#metrics.counters.add(`upgrade_${String(response.statusCode)}`);
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.#pod += 1;
          socket.terminate();
          reject(new Error(`upgrade ${String(response.statusCode)}`));
        }
      });
    });
  }

  #onFrame(frame: {
    type: string;
    afterMs?: number;
    conversationId?: string;
    message?: { ciphertext: string; seq: number };
  }): void {
    switch (frame.type) {
      case 'message': {
        this.#metrics.counters.add('delivered');
        if (frame.conversationId !== undefined && frame.message !== undefined) {
          this.#saw(frame.conversationId, frame.message.seq);
          this.#scheduleAck(frame.conversationId);
        }
        const stamp =
          frame.message === undefined ? Number.NaN : payloadStamp(frame.message.ciphertext);
        if (Number.isFinite(stamp)) this.#metrics.delivery.record(Date.now() - stamp);
        return;
      }
      case 'reconnect': {
        // A pod draining for a deploy: reconnect after its jitter (elsewhere, via the API).
        this.#metrics.counters.add('reconnect_requested');
        this.#disconnectedAt = Date.now();
        this.#pod += 1;
        const socket = this.#socket;
        this.#ready = false;
        if (socket !== null) {
          this.#planned.add(socket);
          socket.close(1000);
        }
        if (this.reconnect) this.#scheduleReconnect(frame.afterMs ?? 0);
        return;
      }
      default:
        this.#metrics.counters.add(`frame_${frame.type}`);
        this.onEvent?.(frame);
    }
  }

  /** Delivery acknowledgement, coalesced as the web client does (150 ms, messaging/store.ts). */
  readonly #ackTimers = new Map<string, NodeJS.Timeout>();
  #scheduleAck(conversationId: string): void {
    if (this.#ackTimers.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.#ackTimers.delete(conversationId);
      const seq = this.#seen.get(conversationId) ?? 0;
      if (seq < 1) return;
      this.request('POST', `/api/v1/conversations/${conversationId}/ack`, { seq }).then(
        (response) => {
          this.#metrics.counters.add(`ack_${String(response.status)}`);
        },
        () => {
          this.#metrics.counters.add('ack_error');
        },
      );
    }, ACK_DELAY_MS);
    timer.unref();
    this.#ackTimers.set(conversationId, timer);
  }

  #saw(conversationId: string, seq: number): void {
    if (seq > (this.#seen.get(conversationId) ?? 0)) this.#seen.set(conversationId, seq);
  }

  /**
   * After a reconnect, as the web client's catch-up (messaging/store.ts): `GET /sync`, then the
   * messages after the last one seen in every conversation that moved. Counts what was
   * recovered this way (missed while offline).
   */
  async #catchUp(): Promise<void> {
    const sync = await this.request('GET', '/api/v1/sync');
    this.#metrics.counters.add(`sync_${String(sync.status)}`);
    if (sync.status !== 200) return;
    const { conversations } = sync.body as { conversations: { id: string; lastSeq: number }[] };
    for (const position of conversations) {
      let after = this.#seen.get(position.id) ?? position.lastSeq;
      if (!this.#seen.has(position.id)) this.#seen.set(position.id, after);
      while (after < position.lastSeq) {
        const page = await this.request(
          'GET',
          `/api/v1/conversations/${position.id}/messages?after=${String(after)}&limit=100`,
        );
        this.#metrics.counters.add(`catchup_${String(page.status)}`);
        if (page.status !== 200) return;
        const { messages } = page.body as { messages: { seq: number }[] };
        if (messages.length === 0) break;
        for (const message of messages) this.#saw(position.id, message.seq);
        this.#metrics.counters.add('recovered', messages.length);
        after = this.#seen.get(position.id) ?? after;
      }
    }
  }

  /** The web client's backoff (messaging/backoff.ts): full jitter, 500 ms base, 30 s cap. */
  #backoff(): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    return Math.floor(Math.random() * ceiling);
  }

  #scheduleReconnect(delayMs: number): void {
    this.#waiting = true;
    setTimeout(() => {
      this.#waiting = false;
      this.connect().catch(() => {
        this.#metrics.counters.add('reconnect_failed');
        this.#scheduleReconnect(this.#backoff());
      });
    }, delayMs).unref();
  }

  /** POST a message; records the API latency; returns the HTTP status. */
  async send(conversationId: string, payloadBytes: number): Promise<number> {
    const started = Date.now();
    const response = await this.request(
      'POST',
      `/api/v1/conversations/${conversationId}/messages`,
      {
        clientMessageId: newId(),
        senderDeviceId: this.user.deviceId,
        epoch: 0,
        ciphertext: stampedPayload(payloadBytes, started),
      },
    );
    const latency = Date.now() - started;
    this.#metrics.send.record(latency);
    // Where in the run slow sends happened (10 s windows by start time; see steady's `stalls`).
    if (latency >= SLOW_MS)
      this.#metrics.counters.add(`${SLOW_PREFIX}${String(Math.floor(started / 10_000) * 10)}`);
    this.#metrics.counters.add(
      response.status === 201 ? 'sent' : `send_${String(response.status)}`,
    );
    return response.status;
  }

  close(): void {
    this.#closing = true;
    this.reconnect = false;
    this.#socket?.terminate();
    this.#ready = false;
  }
}

/** Local addresses to spread connections over (127.0.0.0/8 is all loopback on Linux). */
export function sourceAddresses(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i + 1;
    return `127.0.${String(Math.floor(n / 250) + 1)}.${String((n % 250) + 1)}`;
  });
}
