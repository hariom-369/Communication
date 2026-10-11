import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client.js';

import { RealtimeClient, type ConnectionStatus } from './realtime-client.js';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'ready', heartbeatSeconds: 30 }) });
  }
}

const ticket = () => Promise.resolve({ ticket: 't'.repeat(43), url: '/rt/v1/ws' });

function setup(getTicket: () => Promise<{ ticket: string; url: string }> = ticket) {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const onReady = vi.fn();
  const client = new RealtimeClient({
    getTicket,
    onFrame: vi.fn(),
    onStatus: (status) => statuses.push(status),
    onReady,
    websocketBase: 'ws://test',
    random: () => 0,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { client, sockets, statuses, onReady };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient', () => {
  it('authenticates with the ticket as its first frame', async () => {
    const { client, sockets, statuses, onReady } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      type: 'auth',
      ticket: 't'.repeat(43),
    });
    expect(statuses.at(-1)).toBe('online');
    expect(onReady).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('drops the socket immediately when the browser goes offline and reconnects later', async () => {
    const { client, sockets, statuses } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    client.interrupt();
    expect(sockets[0]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('offline');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('does nothing on interrupt once stopped', async () => {
    const { client, sockets } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    client.interrupt();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('waits as long as a refused ticket asks before trying again', async () => {
    let refusals = 2;
    const getTicket = vi.fn(() =>
      refusals-- > 0
        ? Promise.reject(
            new ApiError({
              type: 't',
              code: 'RATE_LIMITED',
              title: 'Too many requests',
              status: 429,
              retryAfterSeconds: 3,
            }),
          )
        : ticket(),
    );
    const { client, sockets } = setup(getTicket);
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getTicket).toHaveBeenCalledTimes(1);
    // The backoff alone (random() = 0) would retry at once.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(getTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getTicket).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(1);
    client.stop();
  });

  it('retries other ticket failures on the backoff alone', async () => {
    let failures = 1;
    const getTicket = vi.fn(() =>
      failures-- > 0 ? Promise.reject(new Error('network')) : ticket(),
    );
    const { client, sockets } = setup(getTicket);
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    client.stop();
  });
});
