import { randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import {
  MAX_GROUP_MEMBERS,
  addMembersResultSchema,
  conversationSchema,
  createGroupResponseSchema,
  createdInviteLinkSchema,
  invitationListSchema,
  joinRequestListSchema,
} from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDevice } from '../../test/devices.js';
import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * Groups, server side (docs/groups.md, ADR-044). Clients enforce the end-to-end policy on MLS
 * commits separately (crypto-core group_tests.rs); here the server's own API rules are checked.
 */

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

async function user(groupInvites: 'everyone' | 'contacts' | 'nobody' = 'everyone') {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const deviceId = await registerDevice(created.client, me.id);
  if (groupInvites !== 'contacts') {
    const privacy = (await created.client.get('/api/v1/accounts/me/privacy')).json<object>();
    const saved = await created.client.put('/api/v1/accounts/me/privacy', {
      ...privacy,
      groupInvites,
    });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  return { ...created, id: me.id, deviceId };
}
type User = Awaited<ReturnType<typeof user>>;

async function createGroup(owner: User, members: User[]) {
  const response = await owner.client.post('/api/v1/groups', {
    ciphersuite: 1,
    usernames: members.map((m) => m.username),
  });
  expect(response.statusCode, response.body).toBe(201);
  return createGroupResponseSchema.parse(response.json());
}

async function meta(viewer: User, groupId: string) {
  const response = await viewer.client.get(`/api/v1/conversations/${groupId}`);
  return response.statusCode === 200 ? conversationSchema.parse(response.json()) : null;
}

function send(from: User, groupId: string) {
  return from.client.post(`/api/v1/conversations/${groupId}/messages`, {
    clientMessageId: newId(),
    senderDeviceId: from.deviceId,
    epoch: 0,
    ciphertext: randomBytes(32).toString('base64'),
  });
}

describe("'groups.create', 'groups.add_members', 'groups.remove_member' and 'groups.leave'", () => {
  it('creates a group with roles; only admins add and remove; the owner stays until handing over', async () => {
    const [owner, alice, bob, carol] = await Promise.all([user(), user(), user(), user()]);
    const created = await createGroup(owner, [alice, bob]);
    expect(created.added.map((m) => m.username).sort()).toEqual(
      [alice.username, bob.username].sort(),
    );
    const group = created.conversationId;
    const view = await meta(alice, group);
    expect(view).toMatchObject({ kind: 'group', settings: { membersCanAdd: false } });
    expect(Object.fromEntries(view!.members.map((m) => [m.username, m.role]))).toEqual({
      [owner.username]: 'owner',
      [alice.username]: 'member',
      [bob.username]: 'member',
    });

    // A member cannot add or remove.
    expect(
      (await alice.client.post(`/api/v1/groups/${group}/members`, { usernames: [carol.username] }))
        .statusCode,
    ).toBe(403);
    expect(
      (await alice.client.delete(`/api/v1/groups/${group}/members/${bob.id}`)).statusCode,
    ).toBe(403);
    // A non-member sees nothing.
    expect(
      (await carol.client.post(`/api/v1/groups/${group}/members`, { usernames: [bob.username] }))
        .statusCode,
    ).toBe(404);

    // The owner adds; adding again or unknown names are reported, not errors.
    const added = addMembersResultSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${group}/members`, {
          usernames: [carol.username, alice.username, 'no_such_user_xyz'],
        })
      ).json(),
    );
    expect(added.added.map((m) => m.username)).toEqual([carol.username]);
    expect(added.skipped).toEqual([
      { username: alice.username, reason: 'member' },
      { username: 'no_such_user_xyz', reason: 'not_found' },
    ]);
    // New members start at the current position (they cannot read earlier messages anyway).
    expect((await meta(carol, group))?.ackedSeq).toBe((await meta(owner, group))?.lastSeq);

    // Remove: the removed person loses the conversation.
    expect(
      (await owner.client.delete(`/api/v1/groups/${group}/members/${bob.id}`)).statusCode,
    ).toBe(200);
    expect(await meta(bob, group)).toBeNull();

    // The owner cannot leave while others remain; members can.
    expect((await owner.client.post(`/api/v1/groups/${group}/leave`, {})).json()).toMatchObject({
      code: 'CONFLICT',
    });
    expect((await alice.client.post(`/api/v1/groups/${group}/leave`, {})).statusCode).toBe(200);
    expect(await meta(alice, group)).toBeNull();
  });

  it(`respects "who can add me to groups" and the ${MAX_GROUP_MEMBERS}-member cap`, async () => {
    const owner = await user();
    const [open, closed, contactsOnly] = await Promise.all([
      user('everyone'),
      user('nobody'),
      user('contacts'),
    ]);
    const created = await createGroup(owner, [open, closed, contactsOnly]);
    expect(created.added.map((m) => m.username)).toEqual([open.username]);
    expect(created.invited.map((m) => m.username).sort()).toEqual(
      [closed.username, contactsOnly.username].sort(),
    );
    // Invited people see the invitation, not the group, until they accept.
    expect(await meta(closed, created.conversationId)).toBeNull();
    const invitations = invitationListSchema.parse(
      (await closed.client.get('/api/v1/group-invitations')).json(),
    );
    expect(invitations.invitations).toEqual([
      expect.objectContaining({
        conversationId: created.conversationId,
        invitedBy: owner.username,
      }),
    ]);
    expect(
      (await closed.client.post(`/api/v1/group-invitations/${created.conversationId}/accept`, {}))
        .statusCode,
    ).toBe(200);
    expect(await meta(closed, created.conversationId)).not.toBeNull();
    expect(
      (await contactsOnly.client.delete(`/api/v1/group-invitations/${created.conversationId}`))
        .statusCode,
    ).toBe(200);
    expect(await meta(contactsOnly, created.conversationId)).toBeNull();
    // Contacts (people with a direct chat) are added directly.
    await owner.client.post('/api/v1/conversations/direct', {
      username: contactsOnly.username,
      ciphersuite: 1,
    });
    const again = addMembersResultSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${created.conversationId}/members`, {
          usernames: [contactsOnly.username],
        })
      ).json(),
    );
    expect(again.added).toHaveLength(1);

    // The member cap: fill the group to the limit, then additions are refused.
    const fillers = Array.from({ length: MAX_GROUP_MEMBERS - 4 }, () => newId());
    await env.db
      .insertInto('users')
      .values(
        fillers.map((id, index) => ({
          id,
          username: `filler_${index}_${id.slice(-6)}`,
          status: 'active' as const,
          accepted_terms_version: '1',
          confirmed_adult_at: new Date(),
        })),
      )
      .execute();
    await env.db
      .insertInto('conversation_members')
      .values(
        fillers.map((id) => ({
          conversation_id: created.conversationId,
          user_id: id,
          role: 'member' as const,
        })),
      )
      .execute();
    const late = await user();
    const full = addMembersResultSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${created.conversationId}/members`, {
          usernames: [late.username],
        })
      ).json(),
    );
    expect(full.skipped).toEqual([{ username: late.username, reason: 'full' }]);
  });
});

describe("'groups.set_role', 'groups.transfer_ownership', 'groups.update_settings' and 'groups.delete'", () => {
  it('only the owner changes roles; admins change settings; announcements-only holds members back', async () => {
    const [owner, admin, member, other] = await Promise.all([user(), user(), user(), user()]);
    const { conversationId: group } = await createGroup(owner, [admin, member, other]);
    expect(
      (
        await admin.client.put(`/api/v1/groups/${group}/members/${member.id}/role`, {
          role: 'admin',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await owner.client.put(`/api/v1/groups/${group}/members/${admin.id}/role`, {
          role: 'admin',
        })
      ).statusCode,
    ).toBe(200);
    // Admins remove members but not other admins or the owner.
    await owner.client.put(`/api/v1/groups/${group}/members/${other.id}/role`, { role: 'admin' });
    expect(
      (await admin.client.delete(`/api/v1/groups/${group}/members/${other.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await admin.client.delete(`/api/v1/groups/${group}/members/${owner.id}`)).statusCode,
    ).toBe(403);

    // Settings: admins only.
    const settings = { membersCanAdd: true, announcementsOnly: true };
    expect((await member.client.put(`/api/v1/groups/${group}/settings`, settings)).statusCode).toBe(
      403,
    );
    expect((await admin.client.put(`/api/v1/groups/${group}/settings`, settings)).statusCode).toBe(
      200,
    );
    expect((await meta(member, group))?.settings).toEqual(settings);
    expect((await send(member, group)).json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await send(admin, group)).statusCode).toBe(201);
    // Members may add when the setting allows.
    const late = await user();
    expect(
      (await member.client.post(`/api/v1/groups/${group}/members`, { usernames: [late.username] }))
        .statusCode,
    ).toBe(200);

    // Ownership goes to an admin only, with re-authentication.
    expect(
      (await owner.client.post(`/api/v1/groups/${group}/owner`, { userId: member.id })).json(),
    ).toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      (await owner.client.post(`/api/v1/groups/${group}/owner`, { userId: admin.id })).statusCode,
    ).toBe(200);
    const roles = Object.fromEntries(
      (await meta(owner, group))!.members.map((m) => [m.userId, m.role]),
    );
    expect([roles[owner.id], roles[admin.id]]).toEqual(['admin', 'owner']);

    // Only the (new) owner deletes the group; it disappears for everyone.
    expect((await owner.client.delete(`/api/v1/groups/${group}`)).statusCode).toBe(403);
    expect((await admin.client.delete(`/api/v1/groups/${group}`)).statusCode).toBe(200);
    for (const viewer of [owner, admin, member]) expect(await meta(viewer, group)).toBeNull();
  });
});

describe("'groups.create_link', 'groups.links', 'groups.revoke_link', 'groups.preview_link', 'groups.request_join', 'groups.join_requests', 'groups.approve_request' and 'groups.reject_request'", () => {
  it('invite links lead to join requests an admin approves; links expire, run out and can be revoked', async () => {
    const [owner, member, joiner, second, third] = await Promise.all([
      user(),
      user(),
      user(),
      user(),
      user(),
    ]);
    const { conversationId: group } = await createGroup(owner, [member]);
    expect(
      (
        await member.client.post(`/api/v1/groups/${group}/links`, {
          expiresInHours: 24,
          maxUses: 2,
          previewTitle: null,
        })
      ).statusCode,
    ).toBe(403);
    const link = createdInviteLinkSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${group}/links`, {
          expiresInHours: 24,
          maxUses: 2,
          previewTitle: 'Book club',
        })
      ).json(),
    );
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Only a digest is stored.
    const stored = await env.db
      .selectFrom('group_links')
      .selectAll()
      .where('id', '=', link.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_digest.includes(Buffer.from(link.token))).toBe(false);

    expect((await joiner.client.get(`/api/v1/invites/${link.token}`)).json()).toEqual({
      previewTitle: 'Book club',
      memberCount: 2,
      alreadyMember: false,
      requested: false,
    });
    // Asking to join does not make you a member.
    const asked = await joiner.client.post(`/api/v1/invites/${link.token}/join`, {});
    expect(asked.json()).toEqual({ groupId: null });
    expect(await meta(joiner, group)).toBeNull();
    const requests = joinRequestListSchema.parse(
      (await owner.client.get(`/api/v1/groups/${group}/requests`)).json(),
    );
    expect(requests.requests.map((r) => r.username)).toEqual([joiner.username]);
    expect((await member.client.get(`/api/v1/groups/${group}/requests`)).statusCode).toBe(403);
    expect(
      (await owner.client.post(`/api/v1/groups/${group}/requests/${joiner.id}/approve`, {}))
        .statusCode,
    ).toBe(200);
    expect(await meta(joiner, group)).not.toBeNull();

    // Second use, then the link is used up.
    await second.client.post(`/api/v1/invites/${link.token}/join`, {});
    expect(
      (await owner.client.delete(`/api/v1/groups/${group}/requests/${second.id}`)).statusCode,
    ).toBe(200);
    expect(await meta(second, group)).toBeNull();
    expect((await third.client.get(`/api/v1/invites/${link.token}`)).statusCode).toBe(404);

    // Revoked and expired links stop working; listing shows only live links.
    const other = createdInviteLinkSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${group}/links`, {
          expiresInHours: 1,
          maxUses: null,
          previewTitle: null,
        })
      ).json(),
    );
    expect(
      (await owner.client.get(`/api/v1/groups/${group}/links`)).json<{ links: unknown[] }>().links,
    ).toHaveLength(1);
    expect(
      (await owner.client.delete(`/api/v1/groups/${group}/links/${other.id}`)).statusCode,
    ).toBe(200);
    expect((await third.client.get(`/api/v1/invites/${other.token}`)).statusCode).toBe(404);
    const expiring = createdInviteLinkSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${group}/links`, {
          expiresInHours: 1,
          maxUses: null,
          previewTitle: null,
        })
      ).json(),
    );
    await env.db
      .updateTable('group_links')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', expiring.id)
      .execute();
    expect((await third.client.post(`/api/v1/invites/${expiring.token}/join`, {})).statusCode).toBe(
      404,
    );
  });
});

describe("'groups.ban', 'groups.bans', 'groups.unban', 'groups.invitations', 'groups.accept_invitation' and 'groups.decline_invitation'", () => {
  it('banned people are removed and cannot come back through links or invitations', async () => {
    const [owner, troll] = await Promise.all([user(), user()]);
    const { conversationId: group } = await createGroup(owner, [troll]);
    expect(
      (await owner.client.post(`/api/v1/groups/${group}/bans`, { userId: troll.id })).statusCode,
    ).toBe(200);
    expect(await meta(troll, group)).toBeNull();
    expect(
      (await owner.client.get(`/api/v1/groups/${group}/bans`))
        .json<{ bans: { username: string }[] }>()
        .bans.map((b) => b.username),
    ).toEqual([troll.username]);
    const link = createdInviteLinkSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${group}/links`, {
          expiresInHours: 1,
          maxUses: null,
          previewTitle: null,
        })
      ).json(),
    );
    expect((await troll.client.post(`/api/v1/invites/${link.token}/join`, {})).statusCode).toBe(
      403,
    );
    const readd = addMembersResultSchema.parse(
      (
        await owner.client.post(`/api/v1/groups/${group}/members`, { usernames: [troll.username] })
      ).json(),
    );
    expect(readd.skipped).toEqual([{ username: troll.username, reason: 'banned' }]);
    expect((await troll.client.get('/api/v1/group-invitations')).json()).toEqual({
      invitations: [],
    });
    expect((await owner.client.delete(`/api/v1/groups/${group}/bans/${troll.id}`)).statusCode).toBe(
      200,
    );
    expect(
      (
        await owner.client.post(`/api/v1/groups/${group}/members`, { usernames: [troll.username] })
      ).json<{ added: unknown[] }>().added,
    ).toHaveLength(1);
  });
});

describe('welcomes for large groups', () => {
  it('stores one copy of a Welcome for all its target devices', async () => {
    const [owner, a, b] = await Promise.all([user(), user(), user()]);
    const { conversationId: group } = await createGroup(owner, [a, b]);
    const welcome = randomBytes(200_000).toString('base64');
    const response = await owner.client.post(`/api/v1/conversations/${group}/commits`, {
      clientMessageId: newId(),
      senderDeviceId: owner.deviceId,
      epoch: 0,
      commit: randomBytes(100_000).toString('base64'),
      welcome,
      welcomeTargets: [
        { userId: a.id, deviceId: a.deviceId },
        { userId: b.id, deviceId: b.deviceId },
      ],
    });
    expect(response.statusCode, response.body).toBe(201);
    const payloads = await env.db
      .selectFrom('mls_welcome_payloads')
      .select('id')
      .where('conversation_id', '=', group)
      .execute();
    expect(payloads).toHaveLength(1);
    for (const member of [a, b]) {
      const list = (await member.client.get(`/api/v1/welcomes?deviceId=${member.deviceId}`)).json<{
        welcomes: { welcome: string }[];
      }>();
      expect(list.welcomes[0]?.welcome).toBe(welcome);
    }
  });
});

describe('key directory for group members', () => {
  it('lets members who never chatted 1:1 read each other’s keys, until one leaves', async () => {
    const [owner, bob, carol] = [await user(), await user(), await user()];
    const stranger = await user();
    const { conversationId } = await createGroup(owner, [bob, carol]);
    const keys = (from: User, of: User) => from.client.get(`/api/v1/keys/users/${of.id}`);
    expect((await keys(bob, carol)).statusCode).toBe(200);
    expect((await keys(carol, bob)).statusCode).toBe(200);
    expect((await keys(stranger, bob)).statusCode).toBe(404);
    const left = await carol.client.post(`/api/v1/groups/${conversationId}/leave`, {});
    expect(left.statusCode, left.body).toBe(200);
    expect((await keys(bob, carol)).statusCode).toBe(404);
  });
});
