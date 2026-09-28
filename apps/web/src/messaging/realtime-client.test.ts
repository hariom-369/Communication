import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function setup() {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const onReady = vi.fn();
  const client = new RealtimeClient({
    getTicket: () => Promise.resolve({ ticket: 't'.repeat(43), url: '/rt/v1/ws' }),
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
});
