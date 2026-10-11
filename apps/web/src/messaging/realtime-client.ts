import { REALTIME_SUBPROTOCOL, serverFrameSchema, type ServerFrame } from '@tessera/validation';

import { ApiError } from '../api/client.js';

import { backoffDelay } from './backoff.js';

/**
 * Browser side of the realtime connection (docs/realtime.md):
 * ticket (REST, cookie-authenticated) → WebSocket with subprotocol → `auth` frame → `ready`.
 * Reconnects with exponential backoff and full jitter; honours server `reconnect` hints during
 * deploys and the `Retry-After` of a refused ticket (admission control, docs/capacity.md §4). Every server frame is schema-validated before use.
 */

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface RealtimeClientOptions {
  readonly getTicket: () => Promise<{ ticket: string; url: string }>;
  readonly onFrame: (frame: ServerFrame) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Called after every successful (re)authentication, to catch up on missed messages. */
  readonly onReady: () => void;
  readonly createSocket?: (url: string, protocol: string) => WebSocket;
  readonly websocketBase?: string;
  readonly random?: () => number;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const STABLE_AFTER_MS = 60_000;

/** Close codes after which retrying cannot help until the user signs in again. */
const FATAL_CLOSE_CODES = new Set([4401, 4403]);

export class RealtimeClient {
  readonly #options: RealtimeClientOptions;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #frameId = 0;

  constructor(options: RealtimeClientOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#socket?.close(1000, 'Client stopped');
    this.#socket = null;
    this.#options.onStatus('offline');
  }

  /** Reconnects immediately (e.g. when the browser comes back online). */
  reconnectNow(): void {
    if (this.#stopped) return;
    if (this.#socket !== null && this.#socket.readyState <= 1) return;
    this.#clearTimers();
    this.#attempt = 0;
    void this.#connect();
  }

  /**
   * The browser reports it lost connectivity. An open socket can stay silently half-open for a
   * long time, so drop it now and let the backoff loop reconnect once the network is back.
   */
  interrupt(): void {
    if (this.#stopped) return;
    const socket = this.#socket;
    if (socket === null) return;
    socket.onclose = null;
    socket.onmessage = null;
    socket.close(1000, 'Network lost');
    this.#socket = null;
    this.#scheduleReconnect();
  }

  sendTyping(conversationId: string, state: 'start' | 'stop'): void {
    this.#send({ type: 'typing', id: this.#nextId(), conversationId, state });
  }

  #isStopped(): boolean {
    return this.#stopped;
  }

  #nextId(): string {
    this.#frameId += 1;
    return String(this.#frameId);
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(frame));
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    this.#options.onStatus('connecting');
    let ticket: { ticket: string; url: string };
    try {
      ticket = await this.#options.getTicket();
    } catch (error) {
      // Refused by admission control (or a rate limit): not before the server says so.
      const retryAfter =
        error instanceof ApiError && error.problem.status === 429
          ? (error.problem.retryAfterSeconds ?? 0) * 1000
          : 0;
      this.#scheduleReconnect(retryAfter);
      return;
    }
    // stop() may have been called while the ticket request was in flight.
    if (this.#isStopped()) return;

    const base = this.#options.websocketBase ?? window.location.origin.replace(/^http/, 'ws');
    const create = this.#options.createSocket ?? ((url, protocol) => new WebSocket(url, protocol));
    const socket = create(`${base}${ticket.url}`, REALTIME_SUBPROTOCOL);
    this.#socket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', id: this.#nextId(), ticket: ticket.ticket }));
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const frame = serverFrameSchema.safeParse(parsed);
      if (!frame.success) return;
      if (frame.data.type === 'ready') {
        this.#options.onStatus('online');
        this.#stableTimer = setTimeout(() => {
          this.#attempt = 0;
        }, STABLE_AFTER_MS);
        this.#options.onReady();
        return;
      }
      if (frame.data.type === 'reconnect') {
        const delay = frame.data.afterMs;
        socket.onclose = null;
        socket.close(1000, 'Server asked to reconnect');
        this.#options.onStatus('connecting');
        this.#timer = setTimeout(() => void this.#connect(), delay);
        return;
      }
      this.#options.onFrame(frame.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.#socket === socket) this.#socket = null;
      if (this.#stopped) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        // Ticket or session rejected: a fresh ticket may still work (e.g. rotated session),
        // but back off fully so an expired session does not spin.
        this.#attempt = Math.max(this.#attempt, 5);
      }
      this.#scheduleReconnect();
    };
  }

  /** Next attempt after the backoff delay, and not before `minDelayMs` (capped like it). */
  #scheduleReconnect(minDelayMs = 0): void {
    if (this.#stopped) return;
    this.#clearTimers();
    this.#options.onStatus('offline');
    const backoff = backoffDelay(this.#attempt, {
      baseMs: BASE_DELAY_MS,
      capMs: MAX_DELAY_MS,
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
    });
    const delay = Math.max(backoff, Math.min(minDelayMs, MAX_DELAY_MS));
    this.#attempt += 1;
    this.#timer = setTimeout(() => void this.#connect(), delay);
  }

  #clearTimers(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#stableTimer !== null) clearTimeout(this.#stableTimer);
    this.#timer = null;
    this.#stableTimer = null;
  }
}
