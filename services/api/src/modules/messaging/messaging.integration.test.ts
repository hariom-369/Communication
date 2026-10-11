import { randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import {
  conversationListSchema,
  conversationSchema,
  DEFAULT_PRIVACY_SETTINGS,
  messageListSchema,
  userChannel,
  type Conversation,
} from '@tessera/validation';
import { sql } from 'kysely';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDevice } from '../../test/devices.js';
import { requireEnv } from '../../test/integration-env.js';
import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
  type TestClient,
} from '../../test/integration-app.js';

let env: IntegrationApp;
let bus: Redis;
const received = new Map<string, Record<string, unknown>[]>();

beforeAll(async () => {
  env = await startIntegrationApp();
  bus = new Redis(requireEnv('TEST_VALKEY_URL'));
  await bus.psubscribe(`${env.keyPrefix}:rt:user:*`);
  bus.on('pmessage', (_pattern, channel: string, payload: string) => {
    const list = received.get(channel) ?? [];
    list.push(JSON.parse(payload) as Record<string, unknown>);
    received.set(channel, list);
  });
});
afterAll(async () => {
  bus.disconnect();
  await env.close();
});

type User = Awaited<ReturnType<typeof createActiveUser>> & { id: string; deviceId: string };

/** Each test client's registered encryption device. */
const devices = new Map<TestClient, string>();

async function user(): Promise<User> {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const deviceId = await registerDevice(created.client, me.id);
  devices.set(created.client, deviceId);
  return { ...created, id: me.id, deviceId };
}

async function openDirect(from: TestClient, username: string): Promise<Conversation> {
  const response = await from.post('/api/v1/conversations/direct', { username, ciphersuite: 1 });
  expect(response.statusCode, response.body).toBe(200);
  return conversationSchema.parse(response.json());
}

const ciphertext = (bytes = 32) => randomBytes(bytes).toString('base64');

async function send(
  client: TestClient,
  conversationId: string,
  body: {
    clientMessageId?: string;
    epoch?: number;
    ciphertext?: string;
    senderDeviceId?: string;
  } = {},
) {
  return client.post(`/api/v1/conversations/${conversationId}/messages`, {
    clientMessageId: body.clientMessageId ?? newId(),
    senderDeviceId: body.senderDeviceId ?? devices.get(client),
    epoch: body.epoch ?? 0,
    ciphertext: body.ciphertext ?? ciphertext(),
  });
}

async function eventsFor(
  userId: string,
  type: string,
  count = 1,
): Promise<Record<string, unknown>[]> {
  const channel = userChannel(env.keyPrefix, userId);
  for (let i = 0; i < 100; i++) {
    const events = (received.get(channel) ?? []).filter((event) => event['type'] === type);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (received.get(channel) ?? []).filter((event) => event['type'] === type);
}

describe("'messaging.open_direct'", () => {
  it('creates one conversation per pair, found from either side, and tells the peer', async () => {
    const alice = await user();
    const bob = await user();
    const fromAlice = await openDirect(alice.client, bob.username);
    const fromBob = await openDirect(bob.client, alice.username.toUpperCase());
    expect(fromBob.id).toBe(fromAlice.id);
    expect(fromAlice.members.map((m) => m.username).sort()).toEqual(
      [alice.username, bob.username].sort(),
    );
    expect(fromAlice).toMatchObject({ kind: 'direct', ciphersuite: 1, epoch: 0, lastSeq: 0 });
    expect(await eventsFor(bob.id, 'conversation')).toEqual([
      { type: 'conversation', conversationId: fromAlice.id },
    ]);
  });

  it('resolves simultaneous first contact to a single conversation', async () => {
    const alice = await user();
    const bob = await user();
    const [a, b] = await Promise.all([
      openDirect(alice.client, bob.username),
      openDirect(bob.client, alice.username),
    ]);
    expect(a.id).toBe(b.id);
  });

  it('refuses self, unknown and undiscoverable users identically', async () => {
    const alice = await user();
    const hidden = await user();
    await hidden.client.put('/api/v1/accounts/me/privacy', {
      ...DEFAULT_PRIVACY_SETTINGS,
      discoverableByUsername: false,
    });
    for (const username of [alice.username, 'nobody_by_this_name', hidden.username]) {
      const response = await alice.client.post('/api/v1/conversations/direct', {
        username,
        ciphersuite: 1,
      });
      expect(response.json(), username).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });

  it('rejects ciphersuites the server does not support, including the old unprotected one', async () => {
    const alice = await user();
    const bob = await user();
    const response = await alice.client.post('/api/v1/conversations/direct', {
      username: bob.username,
      ciphersuite: 0x004d,
    });
    expect(response.json()).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'Unsupported ciphersuite.',
    });
    const unprotected = await alice.client.post('/api/v1/conversations/direct', {
      username: bob.username,
      ciphersuite: 0,
    });
    expect(unprotected.statusCode).toBe(400);
  });
});

describe("'messaging.send'", () => {
  it('assigns increasing sequence numbers, is idempotent, and fans out to members', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await openDirect(alice.client, bob.username);
    const clientMessageId = newId();
    const payload = ciphertext(100);

    const first = await send(alice.client, conversation.id, {
      clientMessageId,
      ciphertext: payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ seq: 1, duplicate: false });
    const retry = await send(alice.client, conversation.id, {
      clientMessageId,
      ciphertext: payload,
    });
    expect(retry.json()).toMatchObject({ seq: 1, duplicate: true });
    expect((await send(bob.client, conversation.id)).json()).toMatchObject({ seq: 2 });

    const [event] = await eventsFor(bob.id, 'message');
    expect(event).toMatchObject({
      conversationId: conversation.id,
      message: { seq: 1, ciphertext: payload, senderUserId: alice.id },
    });
    expect(await eventsFor(alice.id, 'message', 2)).toHaveLength(2); // sender's other sessions too
  });

  it('keeps a gap-free total order under concurrent senders', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await openDirect(alice.client, bob.username);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        send(i % 2 === 0 ? alice.client : bob.client, conversation.id),
      ),
    );
    const seqs = results.map((r) => r.json<{ seq: number }>().seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('refuses non-members exactly like unknown conversations', async () => {
    const alice = await user();
    const bob = await user();
    const mallory = await user();
    const conversation = await openDirect(alice.client, bob.username);
    for (const id of [conversation.id, newId()]) {
      expect((await send(mallory.client, id)).json(), id).toMatchObject({ code: 'NOT_FOUND' });
      expect(
        (await mallory.client.get(`/api/v1/conversations/${id}/messages`)).json(),
      ).toMatchObject({ code: 'NOT_FOUND' });
      expect((await mallory.client.get(`/api/v1/conversations/${id}`)).json()).toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  });

  it('rejects stale epochs, malformed and oversized ciphertext', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await openDirect(alice.client, bob.username);
    expect((await send(alice.client, conversation.id, { epoch: 3 })).json()).toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      (await send(alice.client, conversation.id, { ciphertext: 'not base64!' })).statusCode,
    ).toBe(400);
    expect(
      (await send(alice.client, conversation.id, { ciphertext: ciphertext(64 * 1024) })).statusCode,
    ).toBe(201);
    expect(
      (await send(alice.client, conversation.id, { ciphertext: ciphertext(64 * 1024 + 3) }))
        .statusCode,
    ).toBe(400);
  });
});

describe("'messaging.list_messages', 'messaging.ack', 'messaging.sync'", () => {
  it('pages history forwards and backwards with exact ciphertext', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await openDirect(alice.client, bob.username);
    const payloads: string[] = [];
    for (let i = 0; i < 7; i++) {
      const payload = ciphertext(20);
      payloads.push(payload);
      await send(alice.client, conversation.id, { ciphertext: payload });
    }
    const forward = messageListSchema.parse(
      (
        await bob.client.get(`/api/v1/conversations/${conversation.id}/messages?after=2&limit=3`)
      ).json(),
    );
    expect(forward.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
    expect(forward.hasMore).toBe(true);
    expect(forward.messages[0]?.ciphertext).toBe(payloads[2]);
    expect(forward.earliestAvailableSeq).toBe(1);

    const backward = messageListSchema.parse(
      (
        await bob.client.get(`/api/v1/conversations/${conversation.id}/messages?before=3&limit=5`)
      ).json(),
    );
    expect(backward.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(backward.hasMore).toBe(false);
  });

  it('in groups, publishes one receipt per message — when the last member has it — not one per member', async () => {
    const owner = await user();
    const members = [await user(), await user()];
    for (const member of members) {
      const privacy = (await member.client.get('/api/v1/accounts/me/privacy')).json<object>();
      await member.client.put('/api/v1/accounts/me/privacy', {
        ...privacy,
        groupInvites: 'everyone',
      });
    }
    const created = await owner.client.post('/api/v1/groups', {
      ciphersuite: 1,
      usernames: members.map((m) => m.username),
    });
    expect(created.statusCode, created.body).toBe(201);
    const groupId = created.json<{ conversationId: string }>().conversationId;
    expect((await send(owner.client, groupId)).statusCode).toBe(201);
    const receipts = () =>
      (received.get(userChannel(env.keyPrefix, owner.id)) ?? []).filter(
        (event) => event['type'] === 'receipt' && event['conversationId'] === groupId,
      );
    // The first member's ack: the message is not with everyone yet — nobody is told.
    expect(
      (await members[0]!.client.post(`/api/v1/conversations/${groupId}/ack`, { seq: 1 }))
        .statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receipts()).toEqual([]);
    // The last one: one receipt, carrying the position everyone has reached.
    expect(
      (await members[1]!.client.post(`/api/v1/conversations/${groupId}/ack`, { seq: 1 }))
        .statusCode,
    ).toBe(200);
    await eventsFor(owner.id, 'receipt');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receipts()).toEqual([
      { type: 'receipt', conversationId: groupId, userId: members[1]!.id, seq: 1 },
    ]);
  });

  it('refuses acks from non-members like a missing conversation, and a stale ack publishes nothing', async () => {
    const alice = await user();
    const bob = await user();
    const mallory = await user();
    const conversation = await openDirect(alice.client, bob.username);
    for (let i = 0; i < 2; i++) await send(alice.client, conversation.id);
    expect(
      (await mallory.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 1 }))
        .statusCode,
    ).toBe(404);
    expect(
      (await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 2 }))
        .statusCode,
    ).toBe(200);
    const before = (await eventsFor(alice.id, 'receipt')).length;
    // At or behind the current position: accepted, nothing changes, nobody is told.
    expect(
      (await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 2 }))
        .statusCode,
    ).toBe(200);
    expect(
      (await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 1 }))
        .statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300)); // a wrongly published receipt lands
    expect((await eventsFor(alice.id, 'receipt')).length).toBe(before);
  });

  it('tracks delivery per member, publishes receipts, and never moves backwards', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await openDirect(alice.client, bob.username);
    for (let i = 0; i < 3; i++) await send(alice.client, conversation.id);

    expect(
      (await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 99 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 2 }))
        .statusCode,
    ).toBe(200);
    await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 1 }); // stale ack is ignored
    const receipts = await eventsFor(alice.id, 'receipt');
    expect(receipts.at(-1)).toEqual({
      type: 'receipt',
      conversationId: conversation.id,
      userId: bob.id,
      seq: 2,
    });

    const seenByAlice = conversationSchema.parse(
      (await alice.client.get(`/api/v1/conversations/${conversation.id}`)).json(),
    );
    expect(seenByAlice).toMatchObject({ lastSeq: 3, ackedSeq: 3, peersAckedSeq: 2 });

    const sync = (await bob.client.get('/api/v1/sync')).json<{
      conversations: { id: string; ackedSeq: number; lastSeq: number }[];
    }>();
    expect(sync.conversations.find((c) => c.id === conversation.id)).toEqual({
      id: conversation.id,
      ackedSeq: 2,
      lastSeq: 3,
    });
  });
});

describe("'messaging.list_conversations' and 'messaging.get_conversation'", () => {
  it('orders conversations by latest activity with cursor pagination', async () => {
    const me = await user();
    const peers = [await user(), await user(), await user()];
    const conversations: Conversation[] = [];
    for (const peer of peers) conversations.push(await openDirect(me.client, peer.username));
    await send(me.client, conversations[0]!.id); // oldest conversation becomes most recent

    const page1 = conversationListSchema.parse(
      (await me.client.get('/api/v1/conversations?limit=2')).json(),
    );
    expect(page1.conversations.map((c) => c.id)).toEqual([
      conversations[0]!.id,
      conversations[2]!.id,
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = conversationListSchema.parse(
      (
        await me.client.get(
          `/api/v1/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        )
      ).json(),
    );
    expect(page2.conversations.map((c) => c.id)).toEqual([conversations[1]!.id]);
    expect(page2.nextCursor).toBeNull();
    expect((await me.client.get('/api/v1/conversations?cursor=garbage')).statusCode).toBe(400);
  });
});

describe("'messaging.set_disappearing' and retention", () => {
  it('applies the timer to new messages and deletes expired or fully delivered ciphertext', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await openDirect(alice.client, bob.username);
    const updated = await alice.client.put(
      `/api/v1/conversations/${conversation.id}/disappearing`,
      { seconds: 86_400 },
    );
    expect(conversationSchema.parse(updated.json()).disappearingSeconds).toBe(86_400);
    expect(
      (
        await alice.client.put(`/api/v1/conversations/${conversation.id}/disappearing`, {
          seconds: 60,
        })
      ).statusCode,
    ).toBe(400);

    for (let i = 0; i < 3; i++) await send(alice.client, conversation.id);
    const list = messageListSchema.parse(
      (await bob.client.get(`/api/v1/conversations/${conversation.id}/messages`)).json(),
    );
    const ttl = Date.parse(list.messages[0]!.expiresAt) - Date.parse(list.messages[0]!.serverTime);
    expect(ttl).toBe(86_400_000);

    await bob.client.post(`/api/v1/conversations/${conversation.id}/ack`, { seq: 1 }); // seq 1 fully delivered
    await env.db
      .updateTable('mailbox_messages')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('conversation_id', '=', conversation.id)
      .where('seq', '=', '2')
      .execute(); // seq 2 expired
    await env.modules.messaging.sweep();

    const remaining = messageListSchema.parse(
      (await bob.client.get(`/api/v1/conversations/${conversation.id}/messages`)).json(),
    );
    expect(remaining.messages.map((m) => m.seq)).toEqual([3]);
    expect(remaining.earliestAvailableSeq).toBe(3);
  });
});

describe("'realtime.ticket' and 'realtime.presence'", () => {
  it('issues single-use tickets bound to the session', async () => {
    const alice = await user();
    const response = await alice.client.post('/api/v1/realtime/ticket');
    expect(response.statusCode).toBe(201);
    const { ticket, url, expiresInSeconds } = response.json<{
      ticket: string;
      url: string;
      expiresInSeconds: number;
    }>();
    expect(url).toBe('/rt/v1/ws');
    expect(expiresInSeconds).toBe(30);
    const stored = JSON.parse(
      (await env.valkey.get(`${env.keyPrefix}:rt:ticket:${ticket}`)) ?? '{}',
    ) as Record<string, string>;
    expect(stored['userId']).toBe(alice.id);
    expect(await env.valkey.ttl(`${env.keyPrefix}:rt:ticket:${ticket}`)).toBeLessThanOrEqual(30);
  });

  it('shows presence only as permitted by privacy settings, reciprocally', async () => {
    const alice = await user();
    const bob = await user();
    const stranger = await user();
    await openDirect(alice.client, bob.username); // alice and bob are contacts
    await env.valkey.set(`${env.keyPrefix}:presence:online:${bob.id}`, '1');
    await env.valkey.set(`${env.keyPrefix}:presence:seen:${bob.id}`, String(Date.now()));

    const asContact = (await alice.client.get(`/api/v1/presence/${bob.id}`)).json<{
      online: boolean | null;
    }>();
    expect(asContact.online).toBe(true);
    const asStranger = (await stranger.client.get(`/api/v1/presence/${bob.id}`)).json<{
      online: boolean | null;
      lastSeenAt: string | null;
    }>();
    expect(asStranger).toMatchObject({ online: null, lastSeenAt: null }); // default: contacts only

    await alice.client.put('/api/v1/accounts/me/privacy', {
      ...DEFAULT_PRIVACY_SETTINGS,
      lastSeen: 'nobody',
    });
    const reciprocal = (await alice.client.get(`/api/v1/presence/${bob.id}`)).json<{
      online: boolean | null;
    }>();
    expect(reciprocal.online).toBeNull();

    await bob.client.put('/api/v1/accounts/me/privacy', {
      ...DEFAULT_PRIVACY_SETTINGS,
      lastSeen: 'everyone',
      onlineStatus: 'nobody',
    });
    const hiddenOnline = (await stranger.client.get(`/api/v1/presence/${bob.id}`)).json<{
      online: boolean | null;
      lastSeenAt: string | null;
    }>();
    expect(hiddenOnline.online).toBeNull();
    expect(hiddenOnline.lastSeenAt).not.toBeNull();
  });

  it('tells realtime to re-check sessions on logout', async () => {
    const alice = await user();
    await alice.client.post('/api/v1/auth/logout');
    expect(await eventsFor(alice.id, 'sessions_changed')).not.toHaveLength(0);
  });
  it('has no column that could hold message plaintext: payloads are opaque bytes', async () => {
    const columns = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('conversations', 'conversation_members', 'direct_pairs', 'mailbox_messages',
                           'mls_welcomes', 'account_keys', 'devices', 'key_packages',
                           'link_sessions', 'backups', 'backup_wraps', 'media_blobs', 'media_links')
        AND data_type IN ('text', 'character varying', 'json', 'jsonb', 'bytea')
      ORDER BY table_name, column_name`.execute(env.db);
    // Only two CHECK-constrained enums are text; the single payload column is bytea, never
    // parsed by the server. A new text/json column here must be justified in review.
    expect(columns.rows).toEqual([
      { table_name: 'account_keys', column_name: 'public_key', data_type: 'bytea' },
      // Backup ciphertext, its manifest (ids, sizes, hashes — no content) and MAC.
      { table_name: 'backup_wraps', column_name: 'credential_id', data_type: 'text' },
      { table_name: 'backup_wraps', column_name: 'kind', data_type: 'text' },
      { table_name: 'backup_wraps', column_name: 'prf_salt', data_type: 'bytea' },
      // The Backup Root Key encrypted under the recovery key / passkey PRF output.
      { table_name: 'backup_wraps', column_name: 'wrap', data_type: 'bytea' },
      { table_name: 'backups', column_name: 'blob', data_type: 'bytea' },
      { table_name: 'backups', column_name: 'mac', data_type: 'bytea' },
      { table_name: 'backups', column_name: 'manifest', data_type: 'text' },
      { table_name: 'conversation_members', column_name: 'role', data_type: 'text' },
      { table_name: 'conversations', column_name: 'kind', data_type: 'text' },
      // Public key material only (Ed25519 public keys, signed certificates, KeyPackages).
      { table_name: 'devices', column_name: 'certificate', data_type: 'bytea' },
      // Device name chosen by its owner (validated charset), never message content.
      { table_name: 'devices', column_name: 'label', data_type: 'text' },
      { table_name: 'devices', column_name: 'signature_key', data_type: 'bytea' },
      { table_name: 'key_packages', column_name: 'key_package', data_type: 'bytea' },
      // Link requests: public keys, device name, and the HPKE-sealed payload (opaque).
      { table_name: 'link_sessions', column_name: 'hpke_public', data_type: 'bytea' },
      { table_name: 'link_sessions', column_name: 'label', data_type: 'text' },
      { table_name: 'link_sessions', column_name: 'sealed', data_type: 'bytea' },
      { table_name: 'link_sessions', column_name: 'short_id', data_type: 'bytea' },
      { table_name: 'link_sessions', column_name: 'signature_public', data_type: 'bytea' },
      { table_name: 'mailbox_messages', column_name: 'ciphertext', data_type: 'bytea' },
      // Message franking (ADR-021): the sender's HMAC commitment to the plaintext (32 bytes, it
      // reveals nothing without the key inside the ciphertext) and the server's tag over it.
      { table_name: 'mailbox_messages', column_name: 'commitment', data_type: 'bytea' },
      { table_name: 'mailbox_messages', column_name: 'franking_tag', data_type: 'text' },
      // Attachments: a random object key, the storage upload id and a status enum. No names,
      // types or content; the blob itself is ciphertext in object storage.
      { table_name: 'media_blobs', column_name: 'object_key', data_type: 'text' },
      { table_name: 'media_blobs', column_name: 'status', data_type: 'text' },
      { table_name: 'media_blobs', column_name: 'upload_id', data_type: 'text' },
      // MLS Welcome: encrypted to the invited device's KeyPackage (RFC 9420 §12.4.3.1).
      { table_name: 'mls_welcomes', column_name: 'welcome', data_type: 'bytea' },
    ]);
  });
});
