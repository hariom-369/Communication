import { createHmac } from 'node:crypto';

import { newId } from '@tessera/shared';

import {
  activeCallSchema,
  callCapabilitiesSchema,
  callSchema,
  conversationSchema,
  createGroupResponseSchema,
  iceConfigSchema,
  joinedCallSchema,
  startedCallSchema,
} from '@tessera/validation';
import { Redis } from 'ioredis';
import { TokenVerifier } from 'livekit-server-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDevice } from '../../test/devices.js';
import {
  TEST_LIVEKIT_SECRET,
  TEST_TURN_SECRET,
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';
import { requireEnv } from '../../test/integration-env.js';

/**
 * Calls control plane (docs/calling.md, ADR-016/017/047): call records, who may start, answer
 * and join, short-lived TURN credentials and SFU tokens, ringing hints, and housekeeping.
 * Media and signalling never pass through these routes.
 */

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

async function user(calls: 'everyone' | 'contacts' | 'nobody' = 'contacts') {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const deviceId = await registerDevice(created.client, me.id);
  if (calls !== 'contacts') {
    const privacy = (await created.client.get('/api/v1/accounts/me/privacy')).json<object>();
    const saved = await created.client.put('/api/v1/accounts/me/privacy', {
      ...privacy,
      calls,
      groupInvites: 'everyone',
    });
    expect(saved.statusCode, saved.body).toBe(200);
  } else {
    const privacy = (await created.client.get('/api/v1/accounts/me/privacy')).json<object>();
    await created.client.put('/api/v1/accounts/me/privacy', {
      ...privacy,
      groupInvites: 'everyone',
    });
  }
  return { ...created, id: me.id, deviceId };
}
type User = Awaited<ReturnType<typeof user>>;

/** A second (linked) device of the user, inserted directly: linking itself is tested elsewhere. */
async function linkedDevice(who: User): Promise<string> {
  const first = await env.db
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', who.deviceId)
    .executeTakeFirstOrThrow();
  const id = newId();
  await env.db
    .insertInto('devices')
    .values({ ...first, id, created_at: new Date(), last_seen_at: new Date() })
    .execute();
  return id;
}

async function direct(a: User, b: User): Promise<string> {
  const response = await a.client.post('/api/v1/conversations/direct', {
    username: b.username,
    ciphersuite: 1,
  });
  expect(response.statusCode, response.body).toBe(200);
  return conversationSchema.parse(response.json()).id;
}

async function group(owner: User, members: User[]): Promise<string> {
  const response = await owner.client.post('/api/v1/groups', {
    ciphersuite: 1,
    usernames: members.map((m) => m.username),
  });
  expect(response.statusCode, response.body).toBe(201);
  return createGroupResponseSchema.parse(response.json()).conversationId;
}

async function start(caller: User, conversationId: string, media: 'audio' | 'video' = 'video') {
  return caller.client.post('/api/v1/calls', {
    conversationId,
    media,
    deviceId: caller.deviceId,
  });
}

async function started(caller: User, conversationId: string) {
  const response = await start(caller, conversationId);
  expect(response.statusCode, response.body).toBe(200);
  return startedCallSchema.parse(response.json());
}

function join(who: User, callId: string, deviceId = who.deviceId) {
  return who.client.post(`/api/v1/calls/${callId}/join`, { deviceId });
}

function leave(who: User, callId: string, reason = 'hangup') {
  return who.client.post(`/api/v1/calls/${callId}/leave`, { deviceId: who.deviceId, reason });
}

function events(who: User, callId: string) {
  return (received.get(`${env.keyPrefix}:rt:user:${who.id}`) ?? []).filter(
    (event) => event['type'] === 'call' && event['callId'] === callId,
  );
}

async function eventually(check: () => void): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt > 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("'calls.capabilities' and 'calls.ice'", () => {
  it('reports what is configured and issues coturn-style credentials that expire', async () => {
    const alice = await user();
    const caps = await alice.client.get('/api/v1/calls/capabilities');
    expect(callCapabilitiesSchema.parse(caps.json())).toEqual({
      relayAvailable: true,
      groupCallsAvailable: true,
    });
    const before = Math.floor(Date.now() / 1000);
    const ice = iceConfigSchema.parse((await alice.client.post('/api/v1/calls/ice', {})).json());
    expect(ice.relayAvailable).toBe(true);
    const turn = ice.iceServers.find((s) => s.urls.some((u) => u.startsWith('turn')));
    expect(turn?.urls).toContain('turns:turn.tessera.test:443?transport=tcp');
    const [expiry, label] = turn!.username!.split(':');
    expect(Number(expiry) - before).toBeGreaterThanOrEqual(599);
    expect(Number(expiry) - before).toBeLessThanOrEqual(601);
    // The label identifies nobody (TURN servers log usernames).
    expect(label).toMatch(/^[0-9a-f]{16}$/);
    expect(turn!.username).not.toContain(alice.id);
    // coturn's check: base64(HMAC-SHA1(static-auth-secret, username)).
    expect(turn!.credential).toBe(
      createHmac('sha1', TEST_TURN_SECRET).update(turn!.username!).digest('base64'),
    );
    const again = iceConfigSchema.parse((await alice.client.post('/api/v1/calls/ice', {})).json());
    expect(again.iceServers.at(-1)?.username).not.toBe(turn!.username);
  });
});

describe("'calls.start', 'calls.join', 'calls.leave', 'calls.get' and 'calls.active' (1:1)", () => {
  it('rings, is answered by one device, refuses a third and ends when either side hangs up', async () => {
    const alice = await user();
    const bob = await user();
    const conversationId = await direct(alice, bob);
    const { call, created, ice } = await started(alice, conversationId);
    expect(created).toBe(true);
    expect(call).toMatchObject({
      conversationId,
      mode: 'p2p',
      media: 'video',
      state: 'ringing',
      initiatorUserId: alice.id,
      initiatorDeviceId: alice.deviceId,
      participantCount: 1,
      answeredAt: null,
    });
    expect(ice.relayAvailable).toBe(true);
    await eventually(() => {
      expect(events(bob, call.id)).toContainEqual(
        expect.objectContaining({ state: 'ringing', mode: 'p2p', conversationId }),
      );
    });

    // Calling back at the same moment joins the same call instead of starting a second one.
    const glare = startedCallSchema.parse((await start(bob, conversationId)).json());
    expect(glare.created).toBe(false);
    expect(glare.call.id).toBe(call.id);
    const active = activeCallSchema.parse(
      (await bob.client.get(`/api/v1/conversations/${conversationId}/call`)).json(),
    );
    expect(active.call?.id).toBe(call.id);

    const answered = await join(bob, call.id);
    expect(answered.statusCode, answered.body).toBe(200);
    const joined = joinedCallSchema.parse(answered.json());
    expect(joined.call.state).toBe('active');
    expect(joined.call.participantCount).toBe(2);
    expect(joined.sfu).toBeNull();
    await eventually(() => {
      expect(events(alice, call.id)).toContainEqual(expect.objectContaining({ state: 'active' }));
    });

    // A second device of Bob's cannot squeeze into a 1:1 call that is already connected.
    const bobPhone = await linkedDevice(bob);
    expect((await join(bob, call.id, bobPhone)).statusCode).toBe(409);

    const hungUp = await leave(bob, call.id);
    expect(callSchema.parse(hungUp.json())).toMatchObject({
      state: 'ended',
      endReason: 'hangup',
      participantCount: 2,
    });
    await eventually(() => {
      expect(events(alice, call.id)).toContainEqual(expect.objectContaining({ state: 'ended' }));
    });
    const record = callSchema.parse((await alice.client.get(`/api/v1/calls/${call.id}`)).json());
    expect(record.endedAt).not.toBeNull();
    expect((await join(alice, call.id)).statusCode).toBe(409);
    expect(
      activeCallSchema.parse(
        (await alice.client.get(`/api/v1/conversations/${conversationId}/call`)).json(),
      ).call,
    ).toBeNull();
  });

  it('records declined and missed calls', async () => {
    const alice = await user();
    const bob = await user();
    const conversationId = await direct(alice, bob);
    const first = await started(alice, conversationId);
    const declined = callSchema.parse((await leave(bob, first.call.id, 'declined')).json());
    expect(declined.endReason).toBe('declined');
    const second = await started(alice, conversationId);
    expect(second.created).toBe(true);
    const missed = callSchema.parse((await leave(alice, second.call.id)).json());
    expect(missed.endReason).toBe('missed');
  });

  it('only lets conversation members and their own devices in, and respects "who can call me"', async () => {
    const alice = await user();
    const bob = await user();
    const mallory = await user();
    const conversationId = await direct(alice, bob);
    // Not a member: indistinguishable from a conversation that does not exist.
    expect((await start(mallory, conversationId)).statusCode).toBe(404);
    // Someone else's device.
    const foreign = await alice.client.post('/api/v1/calls', {
      conversationId,
      media: 'audio',
      deviceId: bob.deviceId,
    });
    expect(foreign.statusCode).toBe(403);
    const { call } = await started(alice, conversationId);
    expect((await mallory.client.get(`/api/v1/calls/${call.id}`)).statusCode).toBe(404);
    expect((await join(mallory, call.id)).statusCode).toBe(404);
    await leave(alice, call.id);

    const shy = await user('nobody');
    const quiet = await direct(alice, shy);
    const refused = await start(alice, quiet);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ detail: string }>().detail).toBe(
      `@${shy.username} does not accept calls.`,
    );
  });
});

describe("'calls.heartbeat' and housekeeping", () => {
  it('stops unanswered ringing, ends calls whose other side went silent, deletes old records', async () => {
    const alice = await user();
    const bob = await user();
    const conversationId = await direct(alice, bob);
    const ringing = await started(alice, conversationId);
    await env.modules.calls.sweep(new Date(Date.now() + 60_000));
    const missed = callSchema.parse(
      (await alice.client.get(`/api/v1/calls/${ringing.call.id}`)).json(),
    );
    expect(missed.endReason).toBe('missed');

    const { call } = await started(alice, conversationId);
    await join(bob, call.id);
    const beat = await alice.client.post(`/api/v1/calls/${call.id}/heartbeat`, {
      deviceId: alice.deviceId,
    });
    expect(beat.statusCode, beat.body).toBe(200);
    // Two minutes later nobody has confirmed: both are dropped and the call ends.
    const swept = await env.modules.calls.sweep(new Date(Date.now() + 120_000));
    expect(swept.dropped).toBeGreaterThanOrEqual(2);
    const ended = callSchema.parse((await alice.client.get(`/api/v1/calls/${call.id}`)).json());
    expect(ended.state).toBe('ended');
    const late = await alice.client.post(`/api/v1/calls/${call.id}/heartbeat`, {
      deviceId: alice.deviceId,
    });
    expect(late.statusCode).toBe(404);

    // Records are kept for the retention period only.
    await env.modules.calls.sweep(new Date(Date.now() + 91 * 24 * 3_600_000));
    expect((await alice.client.get(`/api/v1/calls/${call.id}`)).statusCode).toBe(404);
  });
});

describe('group calls (SFU)', () => {
  it('issues short-lived room tokens to members only and drops people removed from the group', async () => {
    const owner = await user();
    const ana = await user();
    const raj = await user();
    const outsider = await user();
    const groupId = await group(owner, [ana, raj]);
    const { call } = await started(owner, groupId);
    expect(call.mode).toBe('sfu');
    for (const member of [ana, raj]) {
      await eventually(() => {
        expect(events(member, call.id)).toContainEqual(expect.objectContaining({ mode: 'sfu' }));
      });
    }

    const ownerJoin = joinedCallSchema.parse((await join(owner, call.id)).json());
    expect(ownerJoin.sfu?.url).toBe('/sfu');
    const claims = await new TokenVerifier('tessera-it', TEST_LIVEKIT_SECRET).verify(
      ownerJoin.sfu!.token,
    );
    expect(claims.sub).toBe(owner.deviceId);
    expect(claims.video).toMatchObject({
      room: call.id,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(300);
    // A token signed with another secret is not accepted by the SFU.
    await expect(
      new TokenVerifier('tessera-it', 'x'.repeat(48)).verify(ownerJoin.sfu!.token),
    ).rejects.toThrow();

    expect((await join(outsider, call.id)).statusCode).toBe(404);
    for (const member of [ana, raj]) expect((await join(member, call.id)).statusCode).toBe(200);
    expect(
      callSchema.parse((await owner.client.get(`/api/v1/calls/${call.id}`)).json())
        .participantCount,
    ).toBe(3);

    // Raj is removed from the group: he can no longer join, and housekeeping drops him.
    const removed = await owner.client.delete(`/api/v1/groups/${groupId}/members/${raj.id}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await join(raj, call.id)).statusCode).toBe(404);
    await env.modules.calls.sweep();
    expect(
      callSchema.parse((await owner.client.get(`/api/v1/calls/${call.id}`)).json())
        .participantCount,
    ).toBe(2);

    // Leaving does not end a group call until the last person leaves.
    expect(callSchema.parse((await leave(ana, call.id)).json()).state).toBe('active');
    expect(callSchema.parse((await leave(owner, call.id)).json())).toMatchObject({
      state: 'ended',
      endReason: 'hangup',
      participantCount: 3,
    });
  });
});
