import { randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import { conversationSchema, ownKeysSchema, userChannel } from '@tessera/validation';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  certificate,
  keyPackage,
  newIdentity,
  registration,
  type TestIdentity,
} from '../../test/devices.js';
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

interface User {
  client: TestClient;
  id: string;
  username: string;
  password: string;
  identity: TestIdentity;
  deviceId: string;
}

async function user(register = true): Promise<User> {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const identity = newIdentity();
  const deviceId = newId();
  if (register) {
    const response = await created.client.post(
      '/api/v1/keys/devices',
      registration(identity, me.id, deviceId),
    );
    expect(response.statusCode, response.body).toBe(201);
  }
  return { ...created, id: me.id, identity, deviceId };
}

async function contacts(a: User, b: User): Promise<string> {
  const response = await a.client.post('/api/v1/conversations/direct', {
    username: b.username,
    ciphersuite: 1,
  });
  expect(response.statusCode, response.body).toBe(200);
  return conversationSchema.parse(response.json()).id;
}

async function eventsFor(userId: string, type: string): Promise<Record<string, unknown>[]> {
  const channel = userChannel(env.keyPrefix, userId);
  for (let i = 0; i < 100; i++) {
    const events = (received.get(channel) ?? []).filter((event) => event['type'] === type);
    if (events.length > 0) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

describe("'keys.register_device' and 'keys.own'", () => {
  it('sets up the first device with a verified certificate and records it in the audit log', async () => {
    const alice = await user();
    const own = ownKeysSchema.parse((await alice.client.get('/api/v1/keys/me')).json());
    expect(own).toMatchObject({
      askVersion: 1,
      askPublicKey: alice.identity.askPublicKey.toString('base64'),
    });
    expect(own.devices.map((d) => d.deviceId)).toEqual([alice.deviceId]);
    const audit = await env.db
      .selectFrom('audit_log')
      .select(['action', 'target_id'])
      .where('actor_id', '=', alice.id)
      .where('action', '=', 'keys.identity_created')
      .execute();
    expect(audit).toEqual([{ action: 'keys.identity_created', target_id: alice.deviceId }]);
  });

  it('rejects certificates that do not verify or do not match the request', async () => {
    const alice = await user(false);
    const identity = newIdentity();
    const other = newIdentity();
    const deviceId = newId();
    const good = registration(identity, alice.id, deviceId);
    const cases = {
      'signed by another key': {
        ...good,
        certificate: certificate(identity, alice.id, deviceId, {
          signWith: other.askPrivateKey,
        }).toString('base64'),
      },
      'for another user': {
        ...good,
        certificate: certificate(identity, newId(), deviceId).toString('base64'),
      },
      'for another device': { ...good, deviceId: newId() },
      'with another key version': {
        ...good,
        certificate: certificate(identity, alice.id, deviceId, { askVersion: 2 }).toString(
          'base64',
        ),
      },
      truncated: {
        ...good,
        certificate: Buffer.from(good.certificate, 'base64').subarray(1).toString('base64'),
      },
    };
    for (const [name, body] of Object.entries(cases)) {
      const response = await alice.client.post('/api/v1/keys/devices', body);
      expect(response.json(), name).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'Invalid device certificate.',
      });
    }
    // The first identity version must be 1.
    const wrongVersion = registration(newIdentity(2), alice.id);
    expect((await alice.client.post('/api/v1/keys/devices', wrongVersion)).statusCode).toBe(409);
    expect(ownKeysSchema.parse((await alice.client.get('/api/v1/keys/me')).json())).toEqual({
      askVersion: null,
      askPublicKey: null,
      devices: [],
    });
  });

  it('refuses a second identity without an explicit, re-authenticated reset', async () => {
    const alice = await user();
    const again = registration(newIdentity(), alice.id);
    expect((await alice.client.post('/api/v1/keys/devices', again)).json()).toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe("'keys.reset_identity'", () => {
  it('requires step-up, bumps the version, revokes old devices and tells contacts', async () => {
    const alice = await user();
    const bob = await user();
    await contacts(alice, bob);
    const next = newIdentity(2);
    const body = registration(next, alice.id);

    await env.db
      .updateTable('sessions')
      .set({ reauthenticated_at: new Date(Date.now() - 11 * 60_000) })
      .where('user_id', '=', alice.id)
      .execute();
    expect((await alice.client.post('/api/v1/keys/identity/reset', body)).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await alice.client.post('/api/v1/auth/reauth/password', { password: alice.password });

    // The version must be exactly current + 1.
    const skipped = registration(newIdentity(3), alice.id);
    expect((await alice.client.post('/api/v1/keys/identity/reset', skipped)).statusCode).toBe(409);

    const response = await alice.client.post('/api/v1/keys/identity/reset', body);
    expect(response.statusCode, response.body).toBe(201);
    expect(ownKeysSchema.parse(response.json())).toMatchObject({
      askVersion: 2,
      askPublicKey: next.askPublicKey.toString('base64'),
      devices: [{ deviceId: body.deviceId }],
    });
    // The old device's key packages are gone with it.
    const leftovers = await env.db
      .selectFrom('key_packages')
      .select('id')
      .where('device_id', '=', alice.deviceId)
      .execute();
    expect(leftovers).toEqual([]);
    expect(await eventsFor(bob.id, 'keys_changed')).toContainEqual({
      type: 'keys_changed',
      userId: alice.id,
    });
    // The old device can no longer send.
    const conversation = await contacts(alice, bob);
    const send = await alice.client.post(`/api/v1/conversations/${conversation}/messages`, {
      clientMessageId: newId(),
      senderDeviceId: alice.deviceId,
      epoch: 0,
      ciphertext: randomBytes(32).toString('base64'),
    });
    expect(send.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot reset an identity that does not exist', async () => {
    const alice = await user(false);
    const response = await alice.client.post(
      '/api/v1/keys/identity/reset',
      registration(newIdentity(1), alice.id),
    );
    expect(response.json()).toMatchObject({ code: 'CONFLICT' });
  });
});

describe("'keys.user'", () => {
  it('shows keys to the user and to contacts only', async () => {
    const alice = await user();
    const bob = await user();
    const stranger = await user();
    await contacts(alice, bob);
    const fromBob = await bob.client.get(`/api/v1/keys/users/${alice.id}`);
    expect(fromBob.json()).toMatchObject({
      userId: alice.id,
      askVersion: 1,
      askPublicKey: alice.identity.askPublicKey.toString('base64'),
      devices: [{ deviceId: alice.deviceId }],
    });
    expect((await alice.client.get(`/api/v1/keys/users/${alice.id}`)).statusCode).toBe(200);
    expect((await stranger.client.get(`/api/v1/keys/users/${alice.id}`)).json()).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports users without encryption keys as not found', async () => {
    const alice = await user();
    const bob = await user(false);
    await contacts(alice, bob);
    expect((await alice.client.get(`/api/v1/keys/users/${bob.id}`)).statusCode).toBe(404);
  });
});

describe("'keys.claim', 'keys.upload_key_packages' and 'keys.key_package_count'", () => {
  it('hands out each one-time key package once, even to concurrent claimers', async () => {
    const alice = await user();
    const bob = await user();
    const carol = await user();
    await contacts(bob, alice);
    await contacts(carol, alice);
    // Alice registered 3 one-time packages; 6 concurrent claims from two contacts.
    const claims = await Promise.all(
      [bob, carol, bob, carol, bob, carol].map((claimer) =>
        claimer.client.post('/api/v1/keys/claim', { userId: alice.id }),
      ),
    );
    const packages = claims.map((response) => {
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ keyPackages: { deviceId: string; keyPackage: string }[] }>();
      expect(body.keyPackages).toHaveLength(1);
      return body.keyPackages[0]!.keyPackage;
    });
    const lastResort = await env.db
      .selectFrom('key_packages')
      .select('key_package')
      .where('device_id', '=', alice.deviceId)
      .where('last_resort', '=', true)
      .executeTakeFirstOrThrow();
    const oneTime = packages.filter((p) => p !== lastResort.key_package.toString('base64'));
    // Exactly three distinct one-time packages; the rest were the (retained) last-resort one.
    expect(new Set(oneTime).size).toBe(3);
    expect(oneTime).toHaveLength(3);
    const count = await alice.client.get(`/api/v1/keys/devices/${alice.deviceId}/key-packages`);
    expect(count.json()).toEqual({ oneTime: 0, lastResort: true });
  });

  it('lets one person add a 40-member group at once (claims are not throttled at group size)', async () => {
    const owner = await user();
    const people: User[] = [];
    for (let i = 0; i < 40; i += 1) {
      const person = await user();
      const privacy = (await person.client.get('/api/v1/accounts/me/privacy')).json<object>();
      await person.client.put('/api/v1/accounts/me/privacy', {
        ...privacy,
        groupInvites: 'everyone',
      });
      people.push(person);
    }
    const created = await owner.client.post('/api/v1/groups', {
      ciphersuite: 1,
      usernames: people.map((p) => p.username),
    });
    expect(created.statusCode, created.body).toBe(201);
    // One claim per person added: twice the old burst of 20 goes through without 429s.
    for (const person of people) {
      const claim = await owner.client.post('/api/v1/keys/claim', { userId: person.id });
      expect(claim.statusCode, claim.body).toBe(200);
    }
  });

  it('refuses claims for non-contacts', async () => {
    const alice = await user();
    const stranger = await user();
    const response = await stranger.client.post('/api/v1/keys/claim', { userId: alice.id });
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tops up key packages for own devices only, within the storage cap', async () => {
    const alice = await user();
    const bob = await user();
    const url = `/api/v1/keys/devices/${alice.deviceId}/key-packages`;
    const topUp = await alice.client.post(url, {
      keyPackages: Array.from({ length: 10 }, keyPackage),
      lastResortKeyPackage: keyPackage(),
    });
    expect(topUp.json()).toEqual({ oneTime: 13, lastResort: true });
    expect((await bob.client.post(url, { keyPackages: [keyPackage()] })).statusCode).toBe(404);
    expect((await bob.client.get(url)).statusCode).toBe(404);
    for (let i = 0; i < 1; i++) {
      await alice.client.post(url, { keyPackages: Array.from({ length: 100 }, keyPackage) });
    }
    const over = await alice.client.post(url, {
      keyPackages: Array.from({ length: 100 }, keyPackage),
    });
    expect(over.json()).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'Too many key packages stored.',
    });
    const oversized = await alice.client.post(url, {
      keyPackages: [randomBytes(5000).toString('base64')],
    });
    expect(oversized.statusCode).toBe(400);
  });
});

describe("'messaging.commit', 'messaging.list_welcomes' and 'messaging.ack_welcome'", () => {
  async function commit(from: User, conversationId: string, body: Record<string, unknown> = {}) {
    return from.client.post(`/api/v1/conversations/${conversationId}/commits`, {
      clientMessageId: newId(),
      senderDeviceId: from.deviceId,
      epoch: 0,
      commit: randomBytes(200).toString('base64'),
      welcome: null,
      welcomeTargets: [],
      ...body,
    });
  }

  it('accepts exactly one commit per epoch and delivers the welcome to the added device', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await contacts(alice, bob);
    const welcome = randomBytes(500).toString('base64');
    const [first, second] = await Promise.all([
      commit(alice, conversation, {
        welcome,
        welcomeTargets: [{ userId: bob.id, deviceId: bob.deviceId }],
      }),
      commit(bob, conversation, {
        welcome,
        welcomeTargets: [{ userId: alice.id, deviceId: alice.deviceId }],
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = first.statusCode === 201 ? alice : bob;
    const loser = winner === alice ? bob : alice;
    expect((first.statusCode === 201 ? first : second).json()).toMatchObject({ seq: 1, epoch: 1 });

    const messages = await loser.client.get(`/api/v1/conversations/${conversation}/messages`);
    expect(messages.json()).toMatchObject({
      messages: [
        {
          seq: 1,
          kind: 'commit',
          senderUserId: winner.id,
          senderDeviceId: winner.deviceId,
          epoch: 0,
        },
      ],
    });
    expect(await eventsFor(loser.id, 'welcome')).toContainEqual({
      type: 'welcome',
      conversationId: conversation,
    });

    const list = await loser.client.get(`/api/v1/welcomes?deviceId=${loser.deviceId}`);
    const welcomes = list.json<{ welcomes: { id: string; commitSeq: number; welcome: string }[] }>()
      .welcomes;
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0]).toMatchObject({ conversationId: conversation, commitSeq: 1, welcome });
    // Other users cannot read or delete it.
    expect(
      (await winner.client.get(`/api/v1/welcomes?deviceId=${loser.deviceId}`)).statusCode,
    ).toBe(403);
    expect((await winner.client.delete(`/api/v1/welcomes/${welcomes[0]!.id}`)).statusCode).toBe(
      404,
    );
    expect((await loser.client.delete(`/api/v1/welcomes/${welcomes[0]!.id}`)).statusCode).toBe(200);
    expect((await loser.client.get(`/api/v1/welcomes?deviceId=${loser.deviceId}`)).json()).toEqual({
      welcomes: [],
    });

    // Application messages must now use epoch 1.
    const stale = await loser.client.post(`/api/v1/conversations/${conversation}/messages`, {
      clientMessageId: newId(),
      senderDeviceId: loser.deviceId,
      epoch: 0,
      ciphertext: randomBytes(32).toString('base64'),
    });
    expect(stale.statusCode).toBe(409);
  });

  it('is idempotent on the client message id', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await contacts(alice, bob);
    const clientMessageId = newId();
    const first = await commit(alice, conversation, { clientMessageId });
    const retry = await commit(alice, conversation, { clientMessageId });
    expect(retry.json()).toMatchObject({
      seq: first.json<{ seq: number }>().seq,
      epoch: 1,
      duplicate: true,
    });
  });

  it('rejects welcomes for non-members, unknown devices and mismatched bodies', async () => {
    const alice = await user();
    const bob = await user();
    const stranger = await user();
    const conversation = await contacts(alice, bob);
    const welcome = randomBytes(100).toString('base64');
    for (const body of [
      { welcome, welcomeTargets: [{ userId: stranger.id, deviceId: stranger.deviceId }] },
      { welcome, welcomeTargets: [{ userId: bob.id, deviceId: newId() }] },
      { welcome, welcomeTargets: [] },
      { welcome: null, welcomeTargets: [{ userId: bob.id, deviceId: bob.deviceId }] },
    ]) {
      expect((await commit(alice, conversation, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    // A device of someone else cannot be used as the sender.
    expect((await commit(alice, conversation, { senderDeviceId: bob.deviceId })).statusCode).toBe(
      403,
    );
    // Non-members cannot commit.
    expect((await commit(stranger, conversation)).statusCode).toBe(404);
  });
});
