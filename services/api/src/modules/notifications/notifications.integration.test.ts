import { randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import {
  PUSH_PAYLOAD_BYTES,
  conversationSchema,
  createGroupResponseSchema,
  notificationConfigSchema,
  notificationPreferencesSchema,
  pushPayloadSchema,
  securityAlertsSchema,
} from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDevice } from '../../test/devices.js';
import {
  TEST_VAPID,
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';
import { FakePushService, type TestSubscription } from '../../test/push-service.js';

/**
 * Notifications (docs/notifications.md, ADR-048): push subscriptions bound to a session and a
 * device; content-free, padded, encrypted pushes (RFC 8291) signed with VAPID (RFC 8292);
 * coalescing; mutes, preferences and quiet hours; no pushes to connected or signed-out sessions;
 * security alerts on every device.
 */

let env: IntegrationApp;
let push: FakePushService;

beforeAll(async () => {
  push = await FakePushService.start();
  env = await startIntegrationApp({ pushTestOrigin: push.origin });
});
afterAll(async () => {
  await env.close();
  await push.close();
});

async function user() {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const deviceId = await registerDevice(created.client, me.id);
  const privacy = (await created.client.get('/api/v1/accounts/me/privacy')).json<object>();
  await created.client.put('/api/v1/accounts/me/privacy', {
    ...privacy,
    calls: 'everyone',
    groupInvites: 'everyone',
  });
  return { ...created, id: me.id, deviceId };
}
type User = Awaited<ReturnType<typeof user>>;

async function sessionOf(who: User): Promise<string> {
  const row = await env.db
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', who.id)
    .where('revoked_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function subscribe(who: User): Promise<TestSubscription> {
  const subscription = push.subscription();
  const response = await who.client.put('/api/v1/notifications/push-subscription', {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    deviceId: who.deviceId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return subscription;
}

async function direct(a: User, b: User): Promise<string> {
  const response = await a.client.post('/api/v1/conversations/direct', {
    username: b.username,
    ciphersuite: 1,
  });
  expect(response.statusCode, response.body).toBe(200);
  return conversationSchema.parse(response.json()).id;
}

const SECRET_TEXT = 'meet me at the old library at nine';

async function send(from: User, conversationId: string): Promise<void> {
  // Opaque client ciphertext; the plaintext above never leaves the "device".
  const response = await from.client.post(`/api/v1/conversations/${conversationId}/messages`, {
    clientMessageId: newId(),
    senderDeviceId: from.deviceId,
    epoch: 0,
    ciphertext: Buffer.concat([Buffer.from(SECRET_TEXT), randomBytes(32)]).toString('base64'),
  });
  expect(response.statusCode, response.body).toBe(201);
}

/** Runs the delivery worker as if `ms` had passed. */
async function drainAfter(ms: number): Promise<void> {
  await env.modules.notifications.drain(new Date(Date.now() + ms));
}

function payloads(subscription: TestSubscription) {
  return push
    .pushesFor(subscription)
    .map((received) =>
      pushPayloadSchema.parse(JSON.parse(FakePushService.decrypt(received, subscription))),
    );
}

describe("'notifications.config', 'notifications.subscribe', 'notifications.unsubscribe'", () => {
  it('binds a subscription to the session and an active device of the account', async () => {
    const alice = await user();
    const before = notificationConfigSchema.parse(
      (await alice.client.get('/api/v1/notifications/config')).json(),
    );
    expect(before).toEqual({
      pushAvailable: true,
      vapidPublicKey: TEST_VAPID.publicKey,
      subscribed: false,
    });
    const subscription = await subscribe(alice);
    expect(
      notificationConfigSchema.parse(
        (await alice.client.get('/api/v1/notifications/config')).json(),
      ).subscribed,
    ).toBe(true);
    const row = await env.db
      .selectFrom('push_subscriptions')
      .selectAll()
      .where('endpoint', '=', subscription.endpoint)
      .executeTakeFirstOrThrow();
    expect(row.session_id).toBe(await sessionOf(alice));
    expect(row.device_id).toBe(alice.deviceId);

    // Someone else's device, a push service not on the allow-list, a malformed key: refused.
    const bob = await user();
    const other = push.subscription();
    const foreign = await alice.client.put('/api/v1/notifications/push-subscription', {
      endpoint: other.endpoint,
      keys: other.keys,
      deviceId: bob.deviceId,
    });
    expect(foreign.statusCode).toBe(403);
    const fresh = push.subscription();
    for (const endpoint of [
      'https://evil.example/push/1',
      'http://push.tessera.test/push/1',
      'https://push.tessera.test:8443/push/1',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const refused = await alice.client.put('/api/v1/notifications/push-subscription', {
        endpoint,
        keys: fresh.keys,
        deviceId: alice.deviceId,
      });
      expect(refused.statusCode, endpoint).toBe(400);
    }
    const allowListed = await alice.client.put('/api/v1/notifications/push-subscription', {
      endpoint: 'https://fcm.push.tessera.test/send/abc',
      keys: fresh.keys,
      deviceId: alice.deviceId,
    });
    expect(allowListed.statusCode).toBe(200);
    const badKey = await alice.client.put('/api/v1/notifications/push-subscription', {
      endpoint: fresh.endpoint,
      keys: { p256dh: 'AAAA', auth: fresh.keys.auth },
      deviceId: alice.deviceId,
    });
    expect(badKey.statusCode).toBe(400);

    // One subscription per session: the last registration replaced the first.
    expect(
      await env.db
        .selectFrom('push_subscriptions')
        .select('endpoint')
        .where('user_id', '=', alice.id)
        .execute(),
    ).toEqual([{ endpoint: 'https://fcm.push.tessera.test/send/abc' }]);
    expect((await alice.client.delete('/api/v1/notifications/push-subscription')).statusCode).toBe(
      200,
    );
    expect(
      await env.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('user_id', '=', alice.id)
        .execute(),
    ).toEqual([]);
  });
});

describe('push delivery', () => {
  it('wakes the recipient with a content-free, padded, encrypted and signed push', async () => {
    const [alice, bob] = [await user(), await user()];
    const conversationId = await direct(alice, bob);
    const bobs = await subscribe(bob);
    const alices = await subscribe(alice);

    await send(alice, conversationId);
    await drainAfter(1000);
    expect(push.pushesFor(bobs)).toHaveLength(0); // still inside the coalescing window
    await drainAfter(6000);

    const [received] = push.pushesFor(bobs);
    expect(received).toBeDefined();
    if (received === undefined) return;
    const plaintext = FakePushService.decrypt(received, bobs);
    expect(Buffer.byteLength(plaintext)).toBe(PUSH_PAYLOAD_BYTES);
    const payload = JSON.parse(plaintext) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['c', 'p', 't']);
    expect(payload).toMatchObject({ t: 'sync', c: conversationId });
    // Nothing of the message — not even its ciphertext — is in the push.
    expect(plaintext).not.toContain('library');
    expect(received.body.toString('latin1')).not.toContain('library');
    expect(received.headers['content-encoding']).toBe('aes128gcm');
    expect(received.headers['ttl']).toBe('3600');
    expect(received.headers['urgency']).toBe('normal');
    // The topic is per subscription: the push service cannot link two people's pushes.
    expect(received.headers['topic']).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(received.headers['topic']).not.toContain(conversationId.slice(0, 8));
    const claims = FakePushService.vapidClaims(received, TEST_VAPID.publicKey);
    expect(claims['aud']).toBe(push.origin);
    expect(claims['sub']).toBe('mailto:push-tests@tessera.test');
    expect(Number(claims['exp']) * 1000).toBeGreaterThan(Date.now());
    // The sender's own devices are not woken.
    expect(push.pushesFor(alices)).toHaveLength(0);
    // Success is recorded.
    const row = await env.db
      .selectFrom('push_subscriptions')
      .select(['last_success_at', 'failures'])
      .where('endpoint', '=', bobs.endpoint)
      .executeTakeFirstOrThrow();
    expect(row.last_success_at).not.toBeNull();
  });

  it('coalesces bursts and delays (never drops) the push after one was just sent', async () => {
    const [alice, bob] = [await user(), await user()];
    const conversationId = await direct(alice, bob);
    const bobs = await subscribe(bob);
    for (let i = 0; i < 3; i += 1) await send(alice, conversationId);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(1);

    // Another message right after: it waits for the 10-second interval, then is pushed.
    await send(alice, conversationId);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(1);
    await drainAfter(11_000);
    expect(payloads(bobs)).toHaveLength(2);
  });

  // 'notifications.mute', 'notifications.unmute', 'notifications.mutes',
  // 'notifications.preferences_get', 'notifications.preferences_update'
  it('respects mutes, preferences and quiet hours', async () => {
    const [alice, bob] = [await user(), await user()];
    const conversationId = await direct(alice, bob);
    const bobs = await subscribe(bob);

    // Muted until unmuted.
    expect(
      (await bob.client.put(`/api/v1/conversations/${conversationId}/mute`, { until: null }))
        .statusCode,
    ).toBe(200);
    const mutes = (await bob.client.get('/api/v1/notifications/mutes')).json<{
      mutes: unknown[];
    }>();
    expect(mutes.mutes).toEqual([{ conversationId, until: null }]);
    await send(alice, conversationId);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(0);
    // Not a member: cannot mute (no existence oracle either).
    const carol = await user();
    expect(
      (await carol.client.put(`/api/v1/conversations/${conversationId}/mute`, { until: null }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await bob.client.put(`/api/v1/conversations/${conversationId}/mute`, {
          until: new Date(Date.now() - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);

    // Unmuted, but message notifications turned off.
    expect(
      (await bob.client.delete(`/api/v1/conversations/${conversationId}/mute`)).statusCode,
    ).toBe(200);
    const off = await bob.client.put('/api/v1/notifications/preferences', {
      messages: false,
      calls: true,
      channelPosts: true,
      quietHours: null,
    });
    expect(off.statusCode, off.body).toBe(200);
    await send(alice, conversationId);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(0);

    // On again, inside quiet hours (a window around "now" in UTC).
    const nowMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const quiet = {
      messages: true,
      calls: true,
      channelPosts: true,
      quietHours: {
        start: (nowMinutes + 1440 - 60) % 1440,
        end: (nowMinutes + 60) % 1440,
        timeZone: 'UTC',
        allowCalls: true,
      },
    };
    const saved = await bob.client.put('/api/v1/notifications/preferences', quiet);
    expect(notificationPreferencesSchema.parse(saved.json())).toEqual(quiet);
    expect(
      notificationPreferencesSchema.parse(
        (await bob.client.get('/api/v1/notifications/preferences')).json(),
      ),
    ).toEqual(quiet);
    await send(alice, conversationId);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(0);

    // Quiet hours elsewhere in the day: delivered.
    await bob.client.put('/api/v1/notifications/preferences', {
      ...quiet,
      quietHours: {
        ...quiet.quietHours,
        start: (nowMinutes + 120) % 1440,
        end: (nowMinutes + 180) % 1440,
      },
    });
    await send(alice, conversationId);
    await drainAfter(16_000);
    expect(payloads(bobs)).toHaveLength(1);

    const invalid = await bob.client.put('/api/v1/notifications/preferences', {
      ...quiet,
      quietHours: { ...quiet.quietHours, timeZone: 'Mars/Olympus_Mons' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('does not push to someone removed from the group after the message', async () => {
    const [alice, bob, carol] = [await user(), await user(), await user()];
    const created = await alice.client.post('/api/v1/groups', {
      ciphersuite: 1,
      usernames: [bob.username, carol.username],
    });
    expect(created.statusCode, created.body).toBe(201);
    const groupId = createGroupResponseSchema.parse(created.json()).conversationId;
    const [bobs, carols] = [await subscribe(bob), await subscribe(carol)];
    await send(alice, groupId);
    const removed = await alice.client.delete(`/api/v1/groups/${groupId}/members/${carol.id}`);
    expect(removed.statusCode, removed.body).toBe(200);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(1);
    expect(payloads(carols)).toHaveLength(0);
  });

  it('skips connected sessions and signed-out sessions; removes gone subscriptions', async () => {
    const [alice, bob] = [await user(), await user()];
    const conversationId = await direct(alice, bob);
    const bobs = await subscribe(bob);
    const session = await sessionOf(bob);

    // The app is open (the realtime gateway marks the session): no push, realtime delivers.
    await env.valkey.set(`${env.keyPrefix}:presence:session:${session}`, '1', 'EX', 60);
    await send(alice, conversationId);
    await drainAfter(6000);
    expect(payloads(bobs)).toHaveLength(0);
    await env.valkey.del(`${env.keyPrefix}:presence:session:${session}`);

    // The push service says the subscription is gone (410): it is deleted.
    push.statuses.set(bobs.token, 410);
    await send(alice, conversationId);
    await drainAfter(16_000);
    expect(push.pushesFor(bobs)).toHaveLength(1);
    expect(
      await env.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('endpoint', '=', bobs.endpoint)
        .execute(),
    ).toEqual([]);

    // Signed out: a subscription that still exists is not used, and the sweep removes it.
    const again = await subscribe(bob);
    expect((await bob.client.post('/api/v1/auth/logout', {})).statusCode).toBe(200);
    await send(alice, conversationId);
    await drainAfter(32_000);
    expect(push.pushesFor(again)).toHaveLength(0);
    await env.modules.notifications.sweep();
    expect(
      await env.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('endpoint', '=', again.endpoint)
        .execute(),
    ).toEqual([]);
  });

  it('keeps the subscription when a privilege change rotates the session', async () => {
    const alice = await user();
    const subscription = await subscribe(alice);
    const before = await sessionOf(alice);
    expect(
      (await alice.client.post('/api/v1/auth/reauth/password', { password: alice.password }))
        .statusCode,
    ).toBe(200);
    const after = await sessionOf(alice);
    expect(after).not.toBe(before);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const row = await env.db
        .selectFrom('push_subscriptions')
        .select('session_id')
        .where('endpoint', '=', subscription.endpoint)
        .executeTakeFirst();
      if (row?.session_id === after) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('subscription did not follow the rotated session');
  });

  it('rings calls immediately with high urgency; muting a group silences its calls', async () => {
    const [alice, bob, carol] = [await user(), await user(), await user()];
    const conversationId = await direct(alice, bob);
    const bobs = await subscribe(bob);
    const call = await alice.client.post('/api/v1/calls', {
      conversationId,
      media: 'audio',
      deviceId: alice.deviceId,
    });
    expect(call.statusCode, call.body).toBe(200);
    const callId = call.json<{ call: { id: string } }>().call.id;
    for (let attempt = 0; attempt < 50 && push.pushesFor(bobs).length === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const [ring] = push.pushesFor(bobs);
    expect(ring?.headers['urgency']).toBe('high');
    expect(ring?.headers['ttl']).toBe('45');
    expect(payloads(bobs)[0]).toMatchObject({ t: 'call', c: conversationId, k: callId });

    const created = await alice.client.post('/api/v1/groups', {
      ciphersuite: 1,
      usernames: [bob.username, carol.username],
    });
    const groupId = createGroupResponseSchema.parse(created.json()).conversationId;
    const carols = await subscribe(carol);
    await carol.client.put(`/api/v1/conversations/${groupId}/mute`, { until: null });
    const before = payloads(bobs).length;
    const groupCall = await alice.client.post('/api/v1/calls', {
      conversationId: groupId,
      media: 'video',
      deviceId: alice.deviceId,
    });
    expect(groupCall.statusCode, groupCall.body).toBe(200);
    for (let attempt = 0; attempt < 50 && payloads(bobs).length === before; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(payloads(bobs).at(-1)).toMatchObject({ t: 'call', c: groupId });
    expect(payloads(carols)).toHaveLength(0);
  });

  // 'channels.notifications'
  it('notifies channel subscribers who turned notifications on, and nobody else', async () => {
    const [owner, follower, quiet, outsider] = [
      await user(),
      await user(),
      await user(),
      await user(),
    ];
    const handle = `news_${randomBytes(4).toString('hex')}`;
    const created = await owner.client.post('/api/v1/channels', {
      handle,
      title: 'News',
      description: '',
      visibility: 'public',
      commentsEnabled: false,
      slowModeSeconds: 0,
    });
    expect(created.statusCode, created.body).toBe(201);
    const channelId = created.json<{ id: string }>().id;
    for (const who of [follower, quiet])
      expect(
        (await who.client.post(`/api/v1/channels/${channelId}/subscription`, {})).statusCode,
      ).toBe(200);
    expect(
      (await follower.client.put(`/api/v1/channels/${channelId}/notifications`, { enabled: true }))
        .statusCode,
    ).toBe(200);
    const channel = (await follower.client.get(`/api/v1/channels/${channelId}`)).json<{
      me: { notifications: boolean };
    }>();
    expect(channel.me.notifications).toBe(true);
    // Not subscribed: cannot turn notifications on.
    expect(
      (await outsider.client.put(`/api/v1/channels/${channelId}/notifications`, { enabled: true }))
        .statusCode,
    ).toBe(409);
    const [followers, quiets] = [await subscribe(follower), await subscribe(quiet)];

    const post = await owner.client.post(`/api/v1/channels/${channelId}/posts`, {
      body: 'Launch day',
      previewUrl: null,
      poll: null,
      publish: 'now',
    });
    expect(post.statusCode, post.body).toBe(201);
    await drainAfter(0); // fan-out batch
    await drainAfter(6000);
    expect(payloads(followers)).toEqual([expect.objectContaining({ t: 'channel', c: channelId })]);
    expect(payloads(quiets)).toHaveLength(0);
  });
});

describe("'notifications.alerts', 'notifications.alerts_read'", () => {
  it('records security alerts for every device and pushes them; read markers', async () => {
    const alice = await user();
    const subscription = await subscribe(alice);
    expect(
      (await alice.client.post('/api/v1/auth/reauth/password', { password: alice.password }))
        .statusCode,
    ).toBe(200);
    const changed = await alice.client.put('/api/v1/auth/password', {
      password: 'a different strong passphrase 42!',
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const listed = securityAlertsSchema.parse(
      (await alice.client.get('/api/v1/security-alerts')).json(),
    );
    expect(listed.unread).toBeGreaterThanOrEqual(1);
    const alert = listed.alerts.find((item) => item.headline === 'Your password was changed');
    expect(alert).toMatchObject({ read: false });
    // Pushed at once (security alerts are not coalesced, muted or silenced).
    for (let attempt = 0; attempt < 50 && payloads(subscription).length === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(payloads(subscription)).toContainEqual(expect.objectContaining({ t: 'alert' }));

    if (alert === undefined) return;
    expect(
      (await alice.client.post('/api/v1/security-alerts/read', { upTo: alert.id })).statusCode,
    ).toBe(200);
    const after = securityAlertsSchema.parse(
      (await alice.client.get('/api/v1/security-alerts')).json(),
    );
    expect(after.alerts.find((item) => item.id === alert.id)?.read).toBe(true);
    // Another person sees none of them.
    const bob = await user();
    const theirs = securityAlertsSchema.parse(
      (await bob.client.get('/api/v1/security-alerts')).json(),
    );
    expect(theirs.alerts.some((item) => item.id === alert.id)).toBe(false);
  });
});
