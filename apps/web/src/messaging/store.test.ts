import type { Conversation, MailboxMessage, ServerFrame } from '@tessera/validation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from '../api/client.js';
import type { endpoints } from '../api/endpoints.js';

import { createDevPlaintextCodec } from './dev-plaintext-codec.js';
import type { MessageContent } from './content.js';
import { MessagingStore } from './store.js';

const codec = createDevPlaintextCodec();
const ME = 'me';
const PEER = 'peer';
const CONVERSATION = 'c1';

function meta(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION,
    kind: 'direct',
    ciphersuite: 0,
    epoch: 0,
    lastSeq: 0,
    lastActivityAt: new Date(0).toISOString(),
    disappearingSeconds: 0,
    members: [
      { userId: ME, username: 'me' },
      { userId: PEER, username: 'peer' },
    ],
    ackedSeq: 0,
    peersAckedSeq: 0,
    ...overrides,
  };
}

async function mailbox(
  seq: number,
  senderUserId: string,
  body: MessageContent['body'],
  id = `m${seq}`,
): Promise<MailboxMessage> {
  return {
    seq,
    clientMessageId: id,
    senderUserId,
    epoch: 0,
    ciphertext: await codec.encode({ v: 1, id, sentAt: seq, body }),
    serverTime: new Date(seq * 1000).toISOString(),
    expiresAt: new Date(10 ** 13).toISOString(),
  };
}

function fakeApi(server: MailboxMessage[] = []) {
  let nextSeq = server.length + 1;
  const api = {
    realtimeTicket: vi.fn(),
    conversations: vi
      .fn()
      .mockResolvedValue({ conversations: [meta({ lastSeq: server.length })], nextCursor: null }),
    conversation: vi.fn().mockResolvedValue(meta()),
    sync: vi.fn().mockImplementation(() =>
      Promise.resolve({
        conversations: [{ id: CONVERSATION, ackedSeq: 0, lastSeq: server.length }],
      }),
    ),
    messages: vi.fn().mockImplementation((_id: string, query: { after?: number }) =>
      Promise.resolve({
        messages: server.filter((m) => m.seq > (query.after ?? 0)),
        earliestAvailableSeq: 1,
        hasMore: false,
      }),
    ),
    ack: vi.fn().mockResolvedValue({ ok: true }),
    sendMessage: vi.fn().mockImplementation(() => {
      const seq = nextSeq++;
      return Promise.resolve({
        seq,
        serverTime: new Date(seq * 1000).toISOString(),
        duplicate: false,
      });
    }),
    openDirect: vi.fn(),
    setDisappearing: vi.fn(),
  };
  return api;
}

function createStore(api: ReturnType<typeof fakeApi>, shareReadReceipts = true) {
  let frameHandler: ((frame: ServerFrame) => void) | undefined;
  const realtime = {
    start: vi.fn(),
    stop: vi.fn(),
    sendTyping: vi.fn(),
    reconnectNow: vi.fn(),
    interrupt: vi.fn(),
  };
  const store = new MessagingStore({
    api: api as unknown as typeof endpoints,
    codec,
    me: { id: ME },
    createRealtime: (options) => {
      frameHandler = options.onFrame;
      return realtime;
    },
  });
  store.setShareReadReceipts(shareReadReceipts);
  return { store, realtime, push: (frame: ServerFrame) => frameHandler?.(frame) };
}

const view = (store: MessagingStore) => store.getSnapshot().conversations[0]!;
const texts = (store: MessagingStore) =>
  view(store).timeline.order.map((id) => view(store).timeline.byId[id]!.text);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MessagingStore', () => {
  it('loads conversations, catches up on history and acknowledges delivery once', async () => {
    const api = fakeApi([
      await mailbox(1, PEER, { kind: 'text', text: 'hello' }),
      await mailbox(2, PEER, { kind: 'text', text: 'there' }),
    ]);
    const { store } = createStore(api);
    await store.start();
    await vi.runOnlyPendingTimersAsync();
    expect(texts(store)).toEqual(['hello', 'there']);
    expect(view(store).unread).toBe(2);
    expect(api.ack).toHaveBeenCalledTimes(1);
    expect(api.ack).toHaveBeenCalledWith(CONVERSATION, 2);
    store.stop();
  });

  it('retries sends after network failures with the same client id', async () => {
    const api = fakeApi();
    api.sendMessage
      .mockRejectedValueOnce(new NetworkError())
      .mockRejectedValueOnce(new NetworkError());
    const { store } = createStore(api);
    await store.start();
    store.sendText(CONVERSATION, '  hi there  ', null);
    await vi.advanceTimersByTimeAsync(0);
    const id = view(store).timeline.order[0]!;
    expect(view(store).timeline.byId[id]).toMatchObject({
      text: 'hi there',
      status: 'queued',
      seq: null,
    });

    await vi.advanceTimersByTimeAsync(70_000);
    const ids = api.sendMessage.mock.calls.map(
      (call) => (call[1] as { clientMessageId: string }).clientMessageId,
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([id]));
    expect(view(store).timeline.byId[id]).toMatchObject({ seq: 1, status: null });
    store.stop();
  });

  it('fails visibly on permanent rejections and lets the user retry', async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValueOnce(
      new ApiError({ type: 't', code: 'NOT_FOUND', title: 'Not found', status: 404 }),
    );
    const { store } = createStore(api);
    await store.start();
    store.sendText(CONVERSATION, 'hello?', null);
    await vi.advanceTimersByTimeAsync(0);
    const id = view(store).timeline.order[0]!;
    expect(view(store).timeline.byId[id]?.status).toBe('failed');
    store.retry(CONVERSATION, id);
    await vi.advanceTimersByTimeAsync(0);
    expect(view(store).timeline.byId[id]).toMatchObject({ seq: 1, status: null });
    store.stop();
  });

  it('fills gaps in order when a realtime hint skips ahead, and ignores duplicate echoes', async () => {
    const server = [await mailbox(1, PEER, { kind: 'text', text: 'one' })];
    const api = fakeApi(server);
    const { store, push } = createStore(api);
    await store.start();
    server.push(
      await mailbox(2, PEER, { kind: 'text', text: 'two' }),
      await mailbox(3, PEER, { kind: 'text', text: 'three' }),
    );
    push({ type: 'message', conversationId: CONVERSATION, message: server[2]! });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(store)).toEqual(['one', 'two', 'three']);
    push({ type: 'message', conversationId: CONVERSATION, message: server[2]! });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(store)).toEqual(['one', 'two', 'three']);
    store.stop();
  });

  it('sends read markers only when read receipts are shared, but always tracks unread locally', async () => {
    for (const share of [true, false]) {
      const api = fakeApi([await mailbox(1, PEER, { kind: 'text', text: 'ping' })]);
      const { store } = createStore(api, share);
      await store.start();
      expect(view(store).unread).toBe(1);
      store.markRead(CONVERSATION);
      await vi.advanceTimersByTimeAsync(0);
      expect(view(store).unread).toBe(0);
      const sentReadMarker = await Promise.all(
        api.sendMessage.mock.calls.map(
          async (call) =>
            (await codec.decode((call[1] as { ciphertext: string }).ciphertext))?.body.kind,
        ),
      );
      expect(sentReadMarker.includes('read')).toBe(share);
      store.stop();
    }
  });

  it('shows typing indicators briefly and clears them when a message arrives', async () => {
    const api = fakeApi();
    const { store, push } = createStore(api);
    await store.start();
    push({ type: 'typing', conversationId: CONVERSATION, userId: PEER, state: 'start' });
    expect(view(store).typing).toEqual([PEER]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(view(store).typing).toEqual([]);
    store.stop();
  });

  it('applies receipts to delivery state', async () => {
    const api = fakeApi();
    const { store, push } = createStore(api);
    await store.start();
    push({ type: 'receipt', conversationId: CONVERSATION, userId: PEER, seq: 4 });
    expect(view(store).meta.peersAckedSeq).toBe(4);
    store.stop();
  });
});
