import type { Conversation, MailboxMessage, ServerFrame } from '@tessera/validation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from '../api/client.js';
import type { HistoryRecord, IngestResult } from '../crypto/protocol.js';

import type { MessageContent } from './content.js';
import {
  DEFAULT_SECURITY,
  SecurityBlocked,
  type ConversationSecurity,
  type DeviceStatus,
} from './e2ee.js';
import { MessagingStore, type SecurityPort } from './store.js';

/**
 * Transport and state rules of the messaging store. Encryption is replaced by a test double
 * (base64 JSON) — the real MLS path is covered by crypto/engine.test.ts and the E2E suite.
 */

const ME = 'me';
const PEER = 'peer';
const CONVERSATION = 'c1';

function meta(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION,
    kind: 'direct',
    ciphersuite: 1,
    epoch: 1,
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

const encode = (content: unknown) => btoa(encodeURIComponent(JSON.stringify(content)));
const decode = (ciphertext: string) => decodeURIComponent(atob(ciphertext));

function mailbox(
  seq: number,
  senderUserId: string,
  body: MessageContent['body'] | null,
  id = `m${seq}`,
): MailboxMessage {
  return {
    seq,
    kind: body === null ? 'commit' : 'application',
    clientMessageId: id,
    senderUserId,
    senderDeviceId: `${senderUserId}-device`,
    epoch: 1,
    ciphertext: body === null ? 'commit' : encode({ v: 1, id, sentAt: seq, body }),
    serverTime: new Date(seq * 1000).toISOString(),
    expiresAt: new Date(10 ** 13).toISOString(),
  };
}

/** Stateless stand-in for E2eeSession with an in-memory "encrypted" history. */
function fakeSecurity() {
  const history = new Map<string, HistoryRecord[]>();
  const cursors = new Map<string, number>();
  let security: ConversationSecurity = DEFAULT_SECURITY;
  let hasGroup = true;
  const listeners = new Set<() => void>();
  const port = {
    status: 'ready' as DeviceStatus,
    deviceId: `${ME}-device`,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    security: () => security,
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    prepare: vi.fn(() => Promise.resolve()),
    encrypt: vi.fn((_meta: Conversation, content: string) => {
      if (security.keyChanged.length > 0) return Promise.reject(new SecurityBlocked('key-changed'));
      return Promise.resolve({
        ciphertext: btoa(encodeURIComponent(content)),
        epoch: 1,
        senderDeviceId: `${ME}-device`,
      });
    }),
    ingest: vi.fn((m: Conversation, message: MailboxMessage): Promise<IngestResult> => {
      if (!hasGroup) return Promise.resolve({ status: 'no-group' });
      if (message.seq <= (cursors.get(m.id) ?? 0)) return Promise.resolve({ status: 'duplicate' });
      cursors.set(m.id, message.seq);
      if (message.kind === 'commit')
        return Promise.resolve({ status: 'commit', epoch: 2, removedSelf: false });
      if (message.senderDeviceId === `${ME}-device`) return Promise.resolve({ status: 'own' });
      const record: HistoryRecord = {
        seq: message.seq,
        senderUserId: message.senderUserId,
        senderDeviceId: message.senderDeviceId,
        serverTime: message.serverTime,
        clientMessageId: message.clientMessageId,
        content: message.ciphertext === 'garbage' ? null : decode(message.ciphertext),
      };
      history.set(m.id, [...(history.get(m.id) ?? []), record]);
      return Promise.resolve(
        record.content === null
          ? { status: 'undecryptable', reason: 'MLS', record }
          : { status: 'application', record },
      );
    }),
    recordOwn: vi.fn((conversationId: string, record: HistoryRecord) => {
      history.set(conversationId, [...(history.get(conversationId) ?? []), record]);
      return Promise.resolve();
    }),
    history: (conversationId: string) => Promise.resolve(history.get(conversationId) ?? []),
    cursor: (conversationId: string) => Promise.resolve(cursors.get(conversationId) ?? 0),
    processWelcomes: vi.fn(() => Promise.resolve([] as string[])),
    keysChanged: vi.fn(() => Promise.resolve()),
    safetyNumber: vi.fn(),
    setVerified: vi.fn(),
    acknowledgeChange: vi.fn(),
    resetIdentity: vi.fn(),
  };
  return {
    port: port as unknown as SecurityPort,
    mock: port,
    history,
    setSecurity: (next: Partial<ConversationSecurity>) => {
      security = { ...security, ...next };
      for (const listener of listeners) listener();
    },
    setHasGroup: (value: boolean) => {
      hasGroup = value;
    },
    setStatus: (status: DeviceStatus) => {
      port.status = status;
      for (const listener of listeners) listener();
    },
  };
}

function fakeApi(server: MailboxMessage[] = []) {
  let nextSeq = server.length + 1;
  return {
    realtimeTicket: vi.fn(),
    conversations: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ conversations: [meta({ lastSeq: server.length })], nextCursor: null }),
      ),
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
}

function createStore(
  api: ReturnType<typeof fakeApi>,
  security = fakeSecurity(),
  shareReadReceipts = true,
) {
  let frameHandler: ((frame: ServerFrame) => void) | undefined;
  const realtime = {
    start: vi.fn(),
    stop: vi.fn(),
    sendTyping: vi.fn(),
    reconnectNow: vi.fn(),
    interrupt: vi.fn(),
  };
  const store = new MessagingStore({
    api,
    security: security.port,
    me: { id: ME },
    createRealtime: (options) => {
      frameHandler = options.onFrame;
      return realtime;
    },
  });
  store.setShareReadReceipts(shareReadReceipts);
  return { store, realtime, security, push: (frame: ServerFrame) => frameHandler?.(frame) };
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
  it('processes history in order, skips commits and acknowledges delivery once', async () => {
    const api = fakeApi([
      mailbox(1, PEER, null),
      mailbox(2, PEER, { kind: 'text', text: 'hello' }),
      mailbox(3, PEER, { kind: 'text', text: 'there' }),
    ]);
    const { store, security } = createStore(api);
    await store.start();
    await vi.runOnlyPendingTimersAsync();
    expect(texts(store)).toEqual(['hello', 'there']);
    expect(view(store).unread).toBe(2);
    expect(security.mock.ingest.mock.calls.map((call) => call[1].seq)).toEqual([1, 2, 3]);
    expect(api.ack).toHaveBeenCalledTimes(1);
    expect(api.ack).toHaveBeenCalledWith(CONVERSATION, 3);
    store.stop();
    expect(security.mock.stop).toHaveBeenCalled();
  });

  it('restores decrypted history from the device instead of the server', async () => {
    const security = fakeSecurity();
    security.history.set(CONVERSATION, [
      {
        seq: 1,
        senderUserId: PEER,
        senderDeviceId: 'peer-device',
        serverTime: new Date(1000).toISOString(),
        clientMessageId: 'old',
        content: JSON.stringify({
          v: 1,
          id: 'old',
          sentAt: 1,
          body: { kind: 'text', text: 'from last week' },
        }),
      },
    ]);
    const { store } = createStore(fakeApi([]), security);
    await store.start();
    expect(texts(store)).toEqual(['from last week']);
    store.stop();
  });

  it('shows undecryptable messages as such and keeps going', async () => {
    const garbage = { ...mailbox(1, PEER, { kind: 'text', text: 'x' }), ciphertext: 'garbage' };
    const { store } = createStore(
      fakeApi([garbage, mailbox(2, PEER, { kind: 'text', text: 'next' })]),
    );
    await store.start();
    const [first, second] = view(store).timeline.order.map((id) => view(store).timeline.byId[id]!);
    expect(first).toMatchObject({ undecodable: true });
    expect(second).toMatchObject({ text: 'next' });
    store.stop();
  });

  it('stops processing a conversation until its Welcome arrives', async () => {
    const security = fakeSecurity();
    security.setHasGroup(false);
    const server = [mailbox(1, PEER, { kind: 'text', text: 'early' })];
    const api = fakeApi(server);
    const { store, push } = createStore(api, security);
    await store.start();
    expect(texts(store)).toEqual([]);
    expect(api.ack).not.toHaveBeenCalled();
    security.setHasGroup(true);
    push({ type: 'welcome', conversationId: CONVERSATION });
    await vi.advanceTimersByTimeAsync(200);
    expect(texts(store)).toEqual(['early']);
    store.stop();
  });

  it('retries sends after network failures with the same client id', async () => {
    const api = fakeApi();
    api.sendMessage
      .mockRejectedValueOnce(new NetworkError())
      .mockRejectedValueOnce(new NetworkError());
    const { store, security } = createStore(api);
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
    // Encrypted afresh on every attempt, and stored on the device once accepted.
    expect(security.mock.encrypt).toHaveBeenCalledTimes(3);
    expect(security.mock.recordOwn).toHaveBeenCalledTimes(1);
    expect(view(store).timeline.byId[id]).toMatchObject({ seq: 1, status: null });
    store.stop();
  });

  it('catches up and re-encrypts when a commit changed the epoch', async () => {
    const server: MailboxMessage[] = [];
    const api = fakeApi(server);
    const conflict = new ApiError({ type: 't', code: 'CONFLICT', title: 'Conflict', status: 409 });
    api.sendMessage.mockImplementationOnce(() => {
      server.push(mailbox(1, PEER, null));
      return Promise.reject(conflict);
    });
    const { store, security } = createStore(api);
    await store.start();
    store.sendText(CONVERSATION, 'after the commit', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(security.mock.ingest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ seq: 1, kind: 'commit' }),
    );
    expect(security.mock.encrypt).toHaveBeenCalledTimes(2);
    expect(texts(store)).toEqual(['after the commit']);
    expect(view(store).timeline.byId[view(store).timeline.order[0]!]).toMatchObject({
      status: null,
    });
    store.stop();
  });

  it('holds messages while a contact’s key change is unacknowledged', async () => {
    const api = fakeApi();
    const { store, security } = createStore(api);
    await store.start();
    security.setSecurity({ keyChanged: [PEER] });
    store.sendText(CONVERSATION, 'wait for me', null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(view(store).blocked).toBe('key-changed');
    expect(view(store).security.keyChanged).toEqual([PEER]);
    security.setSecurity({ keyChanged: [] });
    store.unblock(CONVERSATION);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(view(store).blocked).toBeNull();
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

  it('fills gaps in order when a realtime hint skips ahead', async () => {
    const server = [mailbox(1, PEER, { kind: 'text', text: 'one' })];
    const api = fakeApi(server);
    const { store, push } = createStore(api);
    await store.start();
    server.push(
      mailbox(2, PEER, { kind: 'text', text: 'two' }),
      mailbox(3, PEER, { kind: 'text', text: 'three' }),
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
      const api = fakeApi([mailbox(1, PEER, { kind: 'text', text: 'ping' })]);
      const { store, security } = createStore(api, fakeSecurity(), share);
      await store.start();
      expect(view(store).unread).toBe(1);
      store.markRead(CONVERSATION);
      await vi.advanceTimersByTimeAsync(0);
      expect(view(store).unread).toBe(0);
      const kinds = security.mock.encrypt.mock.calls.map(
        (call) => (JSON.parse(call[1]) as MessageContent).body.kind,
      );
      expect(kinds.includes('read')).toBe(share);
      store.stop();
    }
  });

  it('re-checks keys when a contact’s keys change', async () => {
    const { store, security, push } = createStore(fakeApi());
    await store.start();
    push({ type: 'keys_changed', userId: PEER });
    await vi.advanceTimersByTimeAsync(0);
    expect(security.mock.keysChanged).toHaveBeenCalledWith(PEER);
    expect(security.mock.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONVERSATION }),
      true,
    );
    store.stop();
  });

  it('shows typing indicators briefly', async () => {
    const { store, push } = createStore(fakeApi());
    await store.start();
    push({ type: 'typing', conversationId: CONVERSATION, userId: PEER, state: 'start' });
    expect(view(store).typing).toEqual([PEER]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(view(store).typing).toEqual([]);
    store.stop();
  });

  it('applies receipts to delivery state', async () => {
    const { store, push } = createStore(fakeApi());
    await store.start();
    push({ type: 'receipt', conversationId: CONVERSATION, userId: PEER, seq: 4 });
    expect(view(store).meta.peersAckedSeq).toBe(4);
    store.stop();
  });

  it('starts messaging by itself once the device is set up (linked or restored)', async () => {
    const security = fakeSecurity();
    security.mock.status = 'setup-required';
    const api = fakeApi([mailbox(1, PEER, { kind: 'text', text: 'hi' })]);
    const { store, realtime } = createStore(api, security);
    await store.start();
    expect(realtime.start).not.toHaveBeenCalled();
    expect(api.conversations).not.toHaveBeenCalled();
    security.setStatus('ready');
    await vi.runOnlyPendingTimersAsync();
    expect(realtime.start).toHaveBeenCalledTimes(1);
    expect(texts(store)).toEqual(['hi']);
    // Further changes do not start it twice.
    security.setStatus('ready');
    await store.resume();
    expect(realtime.start).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it('searches decrypted messages on this device, ignoring case and accents', async () => {
    const api = fakeApi([
      mailbox(1, PEER, { kind: 'text', text: 'Meet at the Café at noon' }),
      mailbox(2, PEER, { kind: 'text', text: 'unrelated' }),
      mailbox(3, PEER, { kind: 'text', text: 'the cafe is closed' }),
    ]);
    const { store } = createStore(api);
    await store.start();
    await vi.runOnlyPendingTimersAsync();
    expect(store.search('CAFÉ').map((r) => r.text)).toEqual([
      'the cafe is closed',
      'Meet at the Café at noon',
    ]);
    expect(store.search('c')).toEqual([]);
    expect(store.search('nothing like this')).toEqual([]);
    // Nothing is sent to the server to search.
    expect(api.messages.mock.calls.length).toBeLessThanOrEqual(1);
    store.stop();
  });
});
