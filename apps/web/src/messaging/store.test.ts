import type { Conversation, MailboxMessage, ServerFrame } from '@tessera/validation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from '../api/client.js';
import type { GroupPolicy, HistoryRecord, IngestResult } from '../crypto/protocol.js';

import type { MessageContent } from './content.js';
import {
  DEFAULT_SECURITY,
  SecurityBlocked,
  type ConversationSecurity,
  type DeviceStatus,
} from './e2ee.js';
import { MessagingStore, type SecurityPort, type StoreOptions } from './store.js';
import { testId } from '../test/ids.js';

/**
 * Transport and state rules of the messaging store. Encryption is replaced by a test double
 * (base64 JSON) — the real MLS path is covered by crypto/engine.test.ts and the E2E suite.
 */

const ME = testId('me');
const PEER = testId('peer');
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
      { userId: ME, username: 'me', role: 'member' },
      { userId: PEER, username: 'peer', role: 'member' },
    ],
    ackedSeq: 0,
    peersAckedSeq: 0,
    settings: null,
    ...overrides,
  };
}

const encode = (content: unknown) => btoa(encodeURIComponent(JSON.stringify(content)));
const decode = (ciphertext: string) => decodeURIComponent(atob(ciphertext));

/** Franking without WebCrypto's thread hop (fake timers): a fixed commitment, same JSON shape. */
const testFrank = (content: MessageContent) =>
  Promise.resolve({
    json: JSON.stringify({ ...content, f: 'A'.repeat(43) + '=' }),
    commitment: 'C'.repeat(43) + '=',
  });

function mailbox(
  seq: number,
  senderUserId: string,
  body: MessageContent['body'] | null,
  id = testId(`m${String(seq)}`),
): MailboxMessage {
  return {
    seq,
    kind: body === null ? 'commit' : 'application',
    clientMessageId: id,
    senderUserId,
    senderDeviceId: testId(`${senderUserId}-device`),
    epoch: 1,
    ciphertext: body === null ? 'commit' : encode({ v: 1, id, sentAt: seq, body }),
    serverTime: new Date(seq * 1000).toISOString(),
    expiresAt: new Date(10 ** 13).toISOString(),
    commitment: null,
    frankingTag: null,
  };
}

/** Stateless stand-in for E2eeSession with an in-memory "encrypted" history. */
function fakeSecurity() {
  const history = new Map<string, HistoryRecord[]>();
  const cursors = new Map<string, number>();
  let security: ConversationSecurity = DEFAULT_SECURITY;
  let hasGroup = true;
  const listeners = new Set<() => void>();
  const membersAdded = new Set<(conversationId: string, users: string[]) => void>();
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
      return Promise.resolve(record);
    }),
    history: (conversationId: string) => Promise.resolve(history.get(conversationId) ?? []),
    cursor: (conversationId: string) => Promise.resolve(cursors.get(conversationId) ?? 0),
    processWelcomes: vi.fn(() => Promise.resolve([] as string[])),
    keysChanged: vi.fn(() => Promise.resolve()),
    safetyNumber: vi.fn(),
    setVerified: vi.fn(),
    acknowledgeChange: vi.fn(),
    resetIdentity: vi.fn(),
    updatePolicy: vi.fn((_meta: Conversation, change: (policy: GroupPolicy) => GroupPolicy) => {
      if (security.policy !== null) security = { ...security, policy: change(security.policy) };
      return Promise.resolve(true);
    }),
    forgetGroup: vi.fn(() => Promise.resolve()),
    onMembersAdded: (listener: (conversationId: string, users: string[]) => void) => {
      membersAdded.add(listener);
      return () => membersAdded.delete(listener);
    },
  };
  return {
    port: port as unknown as SecurityPort,
    mock: port,
    history,
    setSecurity: (next: Partial<ConversationSecurity>) => {
      security = { ...security, ...next };
      for (const listener of listeners) listener();
    },
    membersAdded: (conversationId: string, users: string[]) => {
      for (const listener of membersAdded) listener(conversationId, users);
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
    createGroup: vi.fn(),
    addMembers: vi.fn(),
    removeMember: vi.fn().mockResolvedValue({ ok: true }),
    banMember: vi.fn().mockResolvedValue({ ok: true }),
    leaveGroup: vi.fn().mockResolvedValue({ ok: true }),
    setRole: vi.fn().mockResolvedValue({ ok: true }),
    transferOwnership: vi.fn().mockResolvedValue({ ok: true }),
    updateGroupSettings: vi.fn().mockResolvedValue({ ok: true }),
    deleteGroup: vi.fn().mockResolvedValue({ ok: true }),
    approveJoinRequest: vi.fn().mockResolvedValue({ ok: true }),
    acceptInvitation: vi.fn().mockResolvedValue({ ok: true }),
    joinRequests: vi.fn().mockResolvedValue({ requests: [] }),
    mySpaces: vi.fn().mockResolvedValue({ spaces: [] }),
  };
}

function createStore(
  api: ReturnType<typeof fakeApi>,
  security = fakeSecurity(),
  shareReadReceipts = true,
  media?: StoreOptions['media'],
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
    frank: testFrank,
    ...(media === undefined ? {} : { media }),
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
        senderDeviceId: testId(`${PEER}-device`),
        serverTime: new Date(1000).toISOString(),
        clientMessageId: testId('old'),
        content: JSON.stringify({
          v: 1,
          id: testId('old'),
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

  it('processes the next message straight from the hint, without fetching it', async () => {
    const server = [mailbox(1, PEER, { kind: 'text', text: 'one' })];
    const api = fakeApi(server);
    const { store, push } = createStore(api);
    await store.start();
    const fetches = api.messages.mock.calls.length;
    server.push(mailbox(2, PEER, { kind: 'text', text: 'two' }));
    push({ type: 'message', conversationId: CONVERSATION, message: server[1]! });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(store)).toEqual(['one', 'two']);
    expect(api.messages.mock.calls.length).toBe(fetches);
    store.stop();
  });

  it('a catch-up that fails after a hint (rate limited, offline) is retried by the next one', async () => {
    const server = [mailbox(1, PEER, { kind: 'text', text: 'one' })];
    const api = fakeApi(server);
    const { store, push } = createStore(api);
    await store.start();
    server.push(
      mailbox(2, PEER, { kind: 'text', text: 'two' }),
      mailbox(3, PEER, { kind: 'text', text: 'three' }),
    );
    // A hint that skips ahead needs a fetch; it fails. Not an unhandled rejection (the test run
    // would fail on one): the gap simply stays open.
    api.messages.mockRejectedValueOnce(new Error('Too many requests'));
    push({ type: 'message', conversationId: CONVERSATION, message: server[2]! });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(store)).toEqual(['one']);
    server.push(mailbox(4, PEER, { kind: 'text', text: 'four' }));
    push({ type: 'message', conversationId: CONVERSATION, message: server[3]! });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(store)).toEqual(['one', 'two', 'three', 'four']);
    store.stop();
  });

  it('keeps a message sent while incoming messages are being decrypted', async () => {
    const server: MailboxMessage[] = [];
    const api = fakeApi(server);
    const { store, push, security } = createStore(api);
    await store.start();
    // Decrypting the incoming message takes a while…
    let finish: () => void = () => undefined;
    const ingest = security.mock.ingest.getMockImplementation()!;
    security.mock.ingest.mockImplementationOnce(
      (m: Conversation, message: MailboxMessage) =>
        new Promise<IngestResult>((resolve) => {
          finish = () => resolve(ingest(m, message));
        }),
    );
    server.push(mailbox(1, PEER, { kind: 'text', text: 'theirs' }));
    push({ type: 'message', conversationId: CONVERSATION, message: server[0]! });
    await vi.advanceTimersByTimeAsync(0);
    // …and meanwhile this device's own message is sent (and stored after it).
    api.sendMessage.mockResolvedValueOnce({
      seq: 2,
      serverTime: new Date(2000).toISOString(),
      duplicate: false,
    });
    store.sendText(CONVERSATION, 'mine', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(store)).toEqual(['theirs', 'mine']);
    store.stop();
  });

  it('counts messages the service worker notified about as unread, though delivered', async () => {
    const server = [
      mailbox(1, PEER, { kind: 'text', text: 'seen' }),
      mailbox(2, PEER, { kind: 'text', text: 'notified' }),
    ];
    const api = fakeApi(server);
    // The server has them as delivered (the service worker acknowledged both).
    api.conversations.mockImplementation(() =>
      Promise.resolve({ conversations: [meta({ lastSeq: 2, ackedSeq: 2 })], nextCursor: null }),
    );
    const cleared: string[] = [];
    const store = new MessagingStore({
      api: api,
      security: fakeSecurity().port,
      me: { id: ME },
      frank: testFrank,
      unseen: {
        load: () => Promise.resolve({ [CONVERSATION]: 2 }),
        clear: (id) => cleared.push(id),
      },
      createRealtime: () => ({
        start: vi.fn(),
        stop: vi.fn(),
        sendTyping: vi.fn(),
        reconnectNow: vi.fn(),
        interrupt: vi.fn(),
      }),
    });
    await store.start();
    await vi.runOnlyPendingTimersAsync();
    expect(view(store).unread).toBe(1);
    store.markRead(CONVERSATION);
    expect(view(store).unread).toBe(0);
    expect(cleared).toEqual([CONVERSATION]);
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

  it('uploads an attachment, then sends a message that references it', async () => {
    const bytes32 = btoa('k'.repeat(32));
    const reference = {
      blobId: 'blob-1',
      key: bytes32,
      plaintextSha256: bytes32,
      ciphertextSha256: bytes32,
      plaintextSize: 3,
      ciphertextSize: 42,
    };
    let finish: (value: typeof reference) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const media = {
      upload: vi.fn(
        (_file: Blob, onProgress: (f: number) => void) =>
          new Promise<typeof reference>((resolve, reject) => {
            onProgress(0.5);
            finish = resolve;
            fail = reject;
          }),
      ),
    };
    const api = fakeApi([]);
    const { store, security } = createStore(api, fakeSecurity(), true, media);
    await store.start();
    const file = new Blob(['abc'], { type: 'image/png' });
    const info = { category: 'image' as const, mime: 'image/png', name: 'a.png' };

    const id = store.sendAttachment(CONVERSATION, { file, info }, '  a caption ', null)!;
    expect(store.getSnapshot().uploads[id]).toMatchObject({ fraction: 0.5, name: 'a.png' });
    expect(view(store).timeline.byId[id]).toMatchObject({ text: 'a caption', status: 'sending' });
    // Nothing is sent before the upload finished.
    expect(api.sendMessage).not.toHaveBeenCalled();

    // A failed upload stays visible and can be retried.
    fail(new Error('network'));
    await vi.runOnlyPendingTimersAsync();
    expect(store.getSnapshot().uploads[id]).toMatchObject({ failed: true });
    expect(view(store).timeline.byId[id]?.status).toBe('failed');
    store.retry(CONVERSATION, id);
    finish(reference);
    await vi.runOnlyPendingTimersAsync();

    expect(store.getSnapshot().uploads[id]).toBeUndefined();
    const sent = api.sendMessage.mock.calls[0] as unknown as [
      string,
      { attachments?: string[]; commitment?: string },
    ];
    expect(sent[1].attachments).toEqual(['blob-1']);
    // Franked: the commitment goes with the ciphertext, the key inside it.
    expect(sent[1].commitment).toBe('C'.repeat(43) + '=');
    const json = (security.mock.encrypt.mock.calls.at(-1) as unknown as [unknown, string])[1];
    expect(JSON.parse(json)).toMatchObject({
      id,
      body: { kind: 'media', caption: 'a caption', attachment: { ...info, media: reference } },
    });
    expect(view(store).timeline.byId[id]).toMatchObject({
      attachment: { name: 'a.png' },
      status: null,
    });

    // Cancelling an upload in progress removes it without sending.
    const second = store.sendAttachment(CONVERSATION, { file, info }, '', null)!;
    store.cancelUpload(CONVERSATION, second);
    expect(view(store).timeline.byId[second]).toBeUndefined();
    expect(store.getSnapshot().uploads[second]).toBeUndefined();
    store.stop();
  });
});

describe('groups', () => {
  const groupMeta = (members: [string, 'owner' | 'admin' | 'member'][]) =>
    meta({
      kind: 'group',
      members: members.map(([userId, role]) => ({ userId, username: userId, role })),
      settings: { membersCanAdd: false, announcementsOnly: false },
    });
  const policy = (overrides: Partial<GroupPolicy> = {}): GroupPolicy => ({
    v: 1,
    owner: ME,
    admins: [],
    membersCanAdd: false,
    membersCanEditInfo: true,
    announcementsOnly: false,
    ...overrides,
  });
  const sentBodies = (api: ReturnType<typeof fakeApi>) =>
    api.sendMessage.mock.calls.map(
      (call) =>
        (
          JSON.parse(decode((call[1] as { ciphertext: string }).ciphertext)) as {
            body: { kind: string };
          }
        ).body,
    );

  it('creates a group: the name travels encrypted, followed by the membership intent', async () => {
    const api = fakeApi();
    const created = groupMeta([
      [ME, 'owner'],
      [PEER, 'member'],
    ]);
    api.conversations.mockResolvedValue({ conversations: [], nextCursor: null });
    api.sync.mockResolvedValue({ conversations: [] });
    api.createGroup.mockResolvedValue({
      conversationId: CONVERSATION,
      added: [{ userId: PEER, username: 'peer' }],
      invited: [{ userId: 'invitee', username: 'inv' }],
      skipped: [],
    });
    api.conversation.mockResolvedValue(created);
    const { store, security } = createStore(api);
    await store.start();
    const result = await store.createGroup(' Team ', ['peer', 'inv']);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ id: CONVERSATION, invited: ['inv'], skipped: [] });
    expect(api.createGroup).toHaveBeenCalledWith(['peer', 'inv'], 1);
    expect(JSON.stringify(api.createGroup.mock.calls)).not.toContain('Team');
    expect(sentBodies(api)).toEqual([
      { kind: 'group_info', name: 'Team', description: '' },
      { kind: 'group_members', add: [PEER, 'invitee'], remove: [] },
    ]);
    // The intent being out triggers adding the people it names.
    expect(security.mock.prepare).toHaveBeenCalled();
    store.stop();
  });

  it('sends nothing in an announcement-only group unless this user is an admin', async () => {
    const api = fakeApi();
    api.conversations.mockResolvedValue({
      conversations: [
        groupMeta([
          [PEER, 'owner'],
          [ME, 'member'],
        ]),
      ],
      nextCursor: null,
    });
    const security = fakeSecurity();
    security.setSecurity({ policy: policy({ owner: PEER, announcementsOnly: true }) });
    const { store } = createStore(api, security);
    await store.start();
    store.sendText(CONVERSATION, 'hello', null);
    store.react(CONVERSATION, 'x', '👍');
    store.sendPoll(CONVERSATION, 'Q?', ['a', 'b'], false);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    security.setSecurity({
      policy: policy({ owner: PEER, admins: [ME], announcementsOnly: true }),
    });
    store.sendText(CONVERSATION, 'hello', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it('commits role changes end to end before mirroring them to the server', async () => {
    const api = fakeApi();
    const group = groupMeta([
      [ME, 'owner'],
      [PEER, 'member'],
    ]);
    api.conversations.mockResolvedValue({ conversations: [group], nextCursor: null });
    const security = fakeSecurity();
    security.setSecurity({ policy: policy() });
    const order: string[] = [];
    security.mock.updatePolicy.mockImplementation((_meta, change) => {
      order.push('commit');
      security.setSecurity({ policy: change(policy()) });
      return Promise.resolve(true);
    });
    api.setRole.mockImplementation(() => {
      order.push('server');
      return Promise.resolve({ ok: true });
    });
    const { store } = createStore(api, security);
    await store.start();
    await store.setRole(CONVERSATION, PEER, 'admin');
    expect(order).toEqual(['commit', 'server']);
    expect(api.setRole).toHaveBeenCalledWith(CONVERSATION, PEER, 'admin');
    store.stop();
  });

  it('flags a server copy that fell behind and can finish the change', async () => {
    const api = fakeApi();
    const group = groupMeta([
      [ME, 'owner'],
      [PEER, 'admin'],
    ]);
    api.conversations.mockResolvedValue({ conversations: [group], nextCursor: null });
    api.conversation.mockResolvedValue(group);
    const security = fakeSecurity();
    // Ownership moved end to end, but the re-authentication prompt was cancelled.
    security.setSecurity({ policy: policy({ owner: PEER, admins: [ME] }) });
    const { store } = createStore(api, security);
    await store.start();
    expect(store.serverCopyOutOfSync(CONVERSATION)).toBe(true);
    let prompted = 0;
    const withStepUp = <T>(action: () => Promise<T>): Promise<T | undefined> => {
      prompted += 1;
      return action();
    };
    expect(await store.syncServerCopy(CONVERSATION, withStepUp)).toBe(true);
    expect(api.transferOwnership).toHaveBeenCalledWith(CONVERSATION, PEER);
    expect(prompted).toBe(1);
    store.stop();
  });

  it('shares the group name with people this device just added', async () => {
    const api = fakeApi([
      mailbox(1, PEER, { kind: 'group_info', name: 'Team', description: 'about' }),
    ]);
    const group = groupMeta([
      [PEER, 'owner'],
      [ME, 'admin'],
    ]);
    api.conversations.mockResolvedValue({ conversations: [group], nextCursor: null });
    const security = fakeSecurity();
    security.mock.ingest.mockImplementation((_m: Conversation, message: MailboxMessage) =>
      Promise.resolve({
        status: 'application',
        record: {
          seq: message.seq,
          senderUserId: message.senderUserId,
          senderDeviceId: message.senderDeviceId,
          serverTime: message.serverTime,
          clientMessageId: message.clientMessageId,
          content: decode(message.ciphertext),
          authority: { role: 'owner', editInfo: true, add: true },
        },
      } as IngestResult),
    );
    const { store } = createStore(api, security);
    await store.start();
    expect(view(store).timeline.group.name).toBe('Team');
    security.membersAdded(CONVERSATION, ['newcomer']);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBodies(api)).toEqual([
      { kind: 'group_info', name: 'Team', description: 'about', snapshot: true },
    ]);
    store.stop();
  });

  it('approving someone resolves only once the intent is out and applied', async () => {
    const api = fakeApi();
    const group = groupMeta([
      [ME, 'owner'],
      [PEER, 'member'],
    ]);
    api.conversations.mockResolvedValue({ conversations: [group], nextCursor: null });
    api.conversation.mockResolvedValue(group);
    const security = fakeSecurity();
    security.setSecurity({ policy: policy() });
    const { store } = createStore(api, security);
    await store.start();
    await vi.advanceTimersByTimeAsync(0);
    const order: string[] = [];
    api.sendMessage.mockImplementation(() => {
      order.push('intent sent');
      return Promise.resolve({
        seq: 9,
        serverTime: new Date(9000).toISOString(),
        duplicate: false,
      });
    });
    security.mock.prepare.mockImplementation(() => {
      order.push('membership applied');
      return Promise.resolve();
    });
    await store.approveJoinRequest(CONVERSATION, PEER);
    order.push('approved');
    expect(order).toEqual(['intent sent', 'membership applied', 'approved']);
    store.stop();
  });

  it('marks a group as left when it is no longer visible', async () => {
    const api = fakeApi();
    const group = groupMeta([
      [PEER, 'owner'],
      [ME, 'member'],
    ]);
    api.conversations.mockResolvedValue({ conversations: [group], nextCursor: null });
    const { store, push, security } = createStore(api);
    await store.start();
    api.conversation.mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'x', status: 404, code: 'NOT_FOUND' } as never),
    );
    push({ type: 'conversation', conversationId: CONVERSATION });
    await vi.advanceTimersByTimeAsync(0);
    expect(view(store).removed).toBe(true);
    expect(security.mock.forgetGroup).toHaveBeenCalledWith(CONVERSATION);
    store.sendText(CONVERSATION, 'still here?', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    store.stop();
  });
});

describe('community spaces', () => {
  const spaceMeta = meta({
    kind: 'group',
    members: [
      { userId: ME, username: 'me', role: 'owner' },
      { userId: PEER, username: 'peer', role: 'member' },
    ],
    settings: { membersCanAdd: false, announcementsOnly: false },
  });
  const ownerPolicy = {
    v: 1 as const,
    owner: ME,
    admins: [],
    membersCanAdd: false,
    membersCanEditInfo: true,
    announcementsOnly: false,
  };
  const label = (autoApprove: boolean) => ({
    spaces: [
      {
        conversationId: CONVERSATION,
        communityId: 'c',
        communityName: 'Club',
        name: 'General',
        autoApprove,
      },
    ],
  });

  it('labels spaces and auto-approves requests only in open spaces this user administers', async () => {
    const api = fakeApi();
    api.conversations.mockResolvedValue({ conversations: [spaceMeta], nextCursor: null });
    api.mySpaces.mockResolvedValue(label(true));
    api.joinRequests.mockResolvedValue({
      requests: [{ userId: 'newcomer', username: 'n', createdAt: new Date(0).toISOString() }],
    });
    const security = fakeSecurity();
    security.setSecurity({ policy: ownerPolicy });
    const { store, push } = createStore(api, security);
    await store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().spaces[CONVERSATION]).toMatchObject({ communityName: 'Club' });
    expect(api.approveJoinRequest).toHaveBeenCalledWith(CONVERSATION, 'newcomer');
    // The approval goes out as an encrypted membership intent.
    const bodies = api.sendMessage.mock.calls.map(
      (call) =>
        JSON.parse(decode((call[1] as { ciphertext: string }).ciphertext)) as { body: object },
    );
    expect(bodies.map((b) => b.body)).toContainEqual({
      kind: 'group_members',
      add: ['newcomer'],
      remove: [],
    });

    // Members do not auto-approve; neither do admins of spaces that need approval.
    api.approveJoinRequest.mockClear();
    security.setSecurity({ policy: { ...ownerPolicy, owner: PEER } });
    push({ type: 'group_requests', conversationId: CONVERSATION });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.approveJoinRequest).not.toHaveBeenCalled();
    security.setSecurity({ policy: ownerPolicy });
    api.mySpaces.mockResolvedValue(label(false));
    push({ type: 'community', communityId: 'c' });
    await vi.advanceTimersByTimeAsync(0);
    push({ type: 'group_requests', conversationId: CONVERSATION });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.approveJoinRequest).not.toHaveBeenCalled();
    expect(store.getSnapshot().communityVersion).toBe(1);
    store.stop();
  });
});
