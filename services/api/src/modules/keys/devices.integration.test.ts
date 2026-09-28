import { randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import { MAX_DEVICES, ownKeysSchema, userChannel } from '@tessera/validation';
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
  TestClient,
  type IntegrationApp,
} from '../../test/integration-app.js';

/** Multi-device: linking, adding and revoking devices (docs/multi-device.md). */

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
  email: string;
  username: string;
  password: string;
  identity: TestIdentity;
  deviceId: string;
}

async function user(): Promise<User> {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const identity = newIdentity();
  const deviceId = newId();
  const response = await created.client.post('/api/v1/keys/devices', {
    ...registration(identity, me.id, deviceId),
    label: 'Phone',
  });
  expect(response.statusCode, response.body).toBe(201);
  return { ...created, id: me.id, identity, deviceId };
}

/** A second browser signed in to the same account. */
async function secondSession(account: User): Promise<TestClient> {
  const client = new TestClient(env.app, { ip: account.client.ip });
  const login = await client.post('/api/v1/auth/login', {
    identifier: account.email,
    password: account.password,
  });
  expect(login.statusCode, login.body).toBe(200);
  return client;
}

function linkedDevice(account: User, overrides: Record<string, unknown> = {}) {
  const deviceId = newId();
  return {
    deviceId,
    askVersion: 1,
    certificate: certificate(account.identity, account.id, deviceId).toString('base64'),
    keyPackages: [keyPackage(), keyPackage()],
    lastResortKeyPackage: keyPackage(),
    label: 'Laptop',
    trusted: true,
    ...overrides,
  };
}

async function staleStepUp(userId: string): Promise<void> {
  await env.db
    .updateTable('sessions')
    .set({ reauthenticated_at: new Date(Date.now() - 11 * 60_000) })
    .where('user_id', '=', userId)
    .execute();
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

const b64 = (bytes = 32) => randomBytes(bytes).toString('base64');

describe("'keys.create_link', 'keys.lookup_link', 'keys.approve_link' and 'keys.link_status'", () => {
  it('relays a sealed payload from an existing device to the waiting device, once', async () => {
    const alice = await user();
    const laptop = await secondSession(alice);
    const request = {
      deviceId: newId(),
      hpkePublic: b64(),
      signaturePublic: b64(),
      label: 'Chrome on Linux',
    };
    const created = await laptop.post('/api/v1/keys/links', request);
    expect(created.statusCode, created.body).toBe(201);
    const { linkId, shortId } = created.json<{ linkId: string; shortId: string }>();
    const shortUrl = Buffer.from(shortId, 'base64').toString('base64url');

    // The phone looks it up from the code and sees exactly what the laptop published.
    const lookup = await alice.client.get(`/api/v1/keys/links/by-code/${shortUrl}`);
    expect(lookup.json()).toMatchObject({ linkId, ...request });
    // Nobody else can.
    const bob = await user();
    expect((await bob.client.get(`/api/v1/keys/links/by-code/${shortUrl}`)).statusCode).toBe(404);

    expect((await laptop.get(`/api/v1/keys/links/${linkId}`)).json()).toEqual({
      status: 'pending',
      sealed: null,
    });
    // Approving is a sensitive action (step-up), from a registered device of the same account.
    await staleStepUp(alice.id);
    const sealed = b64(500);
    const stale = await alice.client.post(`/api/v1/keys/links/${linkId}/approve`, {
      approverDeviceId: alice.deviceId,
      sealed,
    });
    expect(stale.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await alice.client.post('/api/v1/auth/reauth/password', { password: alice.password });
    expect(
      (
        await alice.client.post(`/api/v1/keys/links/${linkId}/approve`, {
          approverDeviceId: bob.deviceId,
          sealed,
        })
      ).statusCode,
    ).toBe(403);
    const approve = await alice.client.post(`/api/v1/keys/links/${linkId}/approve`, {
      approverDeviceId: alice.deviceId,
      sealed,
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(await eventsFor(alice.id, 'link_approved')).toContainEqual({
      type: 'link_approved',
      linkId,
    });
    // Only the session that asked receives the payload, and only once.
    expect((await alice.client.get(`/api/v1/keys/links/${linkId}`)).statusCode).toBe(404);
    expect((await laptop.get(`/api/v1/keys/links/${linkId}`)).json()).toEqual({
      status: 'approved',
      sealed,
    });
    expect((await laptop.get(`/api/v1/keys/links/${linkId}`)).statusCode).toBe(404);
  });

  it('expires link requests and limits how many can wait', async () => {
    const alice = await user();
    const laptop = await secondSession(alice);
    const body = () => ({
      deviceId: newId(),
      hpkePublic: b64(),
      signaturePublic: b64(),
      label: 'Tablet',
    });
    // Labels are validated (no markup).
    expect(
      (await laptop.post('/api/v1/keys/links', { ...body(), label: '<img src=x>' })).statusCode,
    ).toBe(400);
    const first = (await laptop.post('/api/v1/keys/links', body())).json<{ shortId: string }>();
    await laptop.post('/api/v1/keys/links', body());
    await laptop.post('/api/v1/keys/links', body());
    expect((await laptop.post('/api/v1/keys/links', body())).statusCode).toBe(429);
    await env.db
      .updateTable('link_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', alice.id)
      .execute();
    const shortUrl = Buffer.from(first.shortId, 'base64').toString('base64url');
    expect((await alice.client.get(`/api/v1/keys/links/by-code/${shortUrl}`)).statusCode).toBe(404);
    expect((await laptop.post('/api/v1/keys/links', body())).statusCode).toBe(201);
  });
});

describe("'keys.add_device' and 'keys.revoke_device'", () => {
  it('adds devices certified by the current identity key, tells contacts and emails the owner', async () => {
    const alice = await user();
    const bob = await user();
    await alice.client.post('/api/v1/conversations/direct', {
      username: bob.username,
      ciphersuite: 1,
    });
    const laptop = await secondSession(alice);
    const body = linkedDevice(alice);
    const added = await laptop.post('/api/v1/keys/devices/linked', body);
    expect(added.statusCode, added.body).toBe(201);
    const own = ownKeysSchema.parse(added.json());
    expect(own.devices.map((d) => [d.deviceId, d.label, d.trusted])).toEqual([
      [alice.deviceId, 'Phone', true],
      [body.deviceId, 'Laptop', true],
    ]);
    // Contacts see the certificate, not the label.
    const seen = (await bob.client.get(`/api/v1/keys/users/${alice.id}`)).json<{
      devices: Record<string, unknown>[];
    }>();
    expect(seen.devices).toHaveLength(2);
    expect(seen.devices[1]).not.toHaveProperty('label');
    expect(await eventsFor(bob.id, 'keys_changed')).toContainEqual({
      type: 'keys_changed',
      userId: alice.id,
    });
    expect(env.mailer.to(alice.email).map((m) => m.subject)).toContain(
      'Tessera security notice: A new device can now read your messages',
    );
    const audit = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('actor_id', '=', alice.id)
      .where('action', '=', 'keys.device_added')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('refuses certificates not signed by the current identity key', async () => {
    const alice = await user();
    const other = newIdentity();
    for (const body of [
      (() => {
        // Right user, device and version, but signed by a key that is not the account's.
        const deviceId = newId();
        return linkedDevice(alice, {
          deviceId,
          certificate: certificate(other, alice.id, deviceId).toString('base64'),
        });
      })(),
      (() => {
        const device = linkedDevice(alice);
        return {
          ...device,
          certificate: certificate(alice.identity, alice.id, newId()).toString('base64'),
        };
      })(),
      (() => {
        const deviceId = newId();
        return linkedDevice(alice, {
          deviceId,
          certificate: certificate(alice.identity, alice.id, deviceId, { askVersion: 2 }).toString(
            'base64',
          ),
        });
      })(),
    ]) {
      expect((await alice.client.post('/api/v1/keys/devices/linked', body)).json()).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'Invalid device certificate.',
      });
    }
  });

  it(`limits accounts to ${MAX_DEVICES} devices`, async () => {
    const alice = await user();
    for (let i = 1; i < MAX_DEVICES; i += 1) {
      expect(
        (await alice.client.post('/api/v1/keys/devices/linked', linkedDevice(alice))).statusCode,
      ).toBe(201);
    }
    const over = await alice.client.post('/api/v1/keys/devices/linked', linkedDevice(alice));
    expect(over.json()).toMatchObject({ code: 'CONFLICT' });
  });

  it('revokes a device with step-up: it disappears from the directory with its key packages', async () => {
    const alice = await user();
    const bob = await user();
    const laptop = linkedDevice(alice);
    await alice.client.post('/api/v1/keys/devices/linked', laptop);
    await staleStepUp(alice.id);
    expect(
      (await alice.client.delete(`/api/v1/keys/devices/${laptop.deviceId}`)).json(),
    ).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await alice.client.post('/api/v1/auth/reauth/password', { password: alice.password });
    // Another account's device cannot be revoked.
    expect((await alice.client.delete(`/api/v1/keys/devices/${bob.deviceId}`)).statusCode).toBe(
      404,
    );
    const revoked = await alice.client.delete(`/api/v1/keys/devices/${laptop.deviceId}`);
    expect(ownKeysSchema.parse(revoked.json()).devices.map((d) => d.deviceId)).toEqual([
      alice.deviceId,
    ]);
    const packages = await env.db
      .selectFrom('key_packages')
      .select('id')
      .where('device_id', '=', laptop.deviceId)
      .execute();
    expect(packages).toEqual([]);
    expect(env.mailer.to(alice.email).map((m) => m.subject)).toContain(
      'Tessera security notice: A device was removed from your encrypted chats',
    );
    // A revoked device can no longer send.
    const conversation = (
      await alice.client.post('/api/v1/conversations/direct', {
        username: bob.username,
        ciphersuite: 1,
      })
    ).json<{ id: string }>();
    const send = await alice.client.post(`/api/v1/conversations/${conversation.id}/messages`, {
      clientMessageId: newId(),
      senderDeviceId: laptop.deviceId,
      epoch: 0,
      ciphertext: b64(),
    });
    expect(send.statusCode).toBe(403);
  });
});
