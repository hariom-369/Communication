import { createHash, randomBytes } from 'node:crypto';

import { COMMUNITY_PERMISSIONS, communitySchema, spaceListSchema } from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDevice } from '../../test/devices.js';
import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * Communities, server side (docs/groups.md §5, ADR-045): verification gate, discovery, role
 * hierarchy, moderation, invite links, and spaces as end-to-end encrypted groups whose
 * membership follows community membership and roles.
 */

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

async function user() {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const deviceId = await registerDevice(created.client, me.id);
  return { ...created, id: me.id, deviceId };
}
type User = Awaited<ReturnType<typeof user>>;

const base = {
  description: 'A place for testing',
  visibility: 'public' as 'public' | 'private',
  rules: 'Be kind.',
  minAccountAgeDays: 0,
};

async function create(owner: User, overrides: Partial<typeof base> & { name?: string } = {}) {
  const response = await owner.client.post('/api/v1/communities', {
    ...base,
    name: `Club ${randomBytes(5).toString('hex')}`,
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function view(viewer: User, id: string) {
  const response = await viewer.client.get(`/api/v1/communities/${id}`);
  return response.statusCode === 200 ? communitySchema.parse(response.json()) : null;
}

async function join(member: User, id: string, rulesVersion = 1) {
  return member.client.post(`/api/v1/communities/${id}/join`, { rulesVersion });
}

async function inSpace(member: User, spaceId: string): Promise<boolean> {
  return (await member.client.get(`/api/v1/conversations/${spaceId}`)).statusCode === 200;
}

describe("'communities.create', 'communities.get', 'communities.update', 'communities.join', 'communities.leave', 'communities.mine', 'communities.discover', 'communities.members' and 'communities.delete'", () => {
  it('enforces the verification gate and lists public communities only', async () => {
    const [owner, alice, bob] = [await user(), await user(), await user()];
    const name = `Gardeners ${Date.now()}`;
    const id = await create(owner, { name, rules: 'No spam.' });
    const hidden = await create(owner, { visibility: 'private' });

    // Discovery: public only; private communities do not exist for outsiders.
    const found = await alice.client.get(
      `/api/v1/community-directory?q=${encodeURIComponent(name.slice(0, 12))}`,
    );
    expect(found.json<{ communities: { id: string }[] }>().communities.map((c) => c.id)).toContain(
      id,
    );
    expect(JSON.stringify(found.json())).not.toContain(hidden);
    expect(await view(alice, hidden)).toBeNull();
    expect((await join(alice, hidden)).statusCode).toBe(404);

    // Rules must be accepted in their current version.
    const outsider = await view(alice, id);
    expect(outsider?.me).toMatchObject({ member: false, permissions: 0 });
    expect((await join(alice, id, 7)).statusCode).toBe(409);
    expect((await join(alice, id, 1)).statusCode).toBe(200);
    expect((await view(alice, id))?.me.member).toBe(true);

    // Changing the rules bumps their version; account age gate.
    const update = await owner.client.patch(`/api/v1/communities/${id}`, {
      rules: 'No spam. No ads.',
      minAccountAgeDays: 30,
    });
    expect(update.statusCode, update.body).toBe(200);
    expect((await view(owner, id))?.rulesVersion).toBe(2);
    const young = await join(bob, id, 2);
    expect(young.statusCode).toBe(403);
    expect(young.json<{ detail: string }>().detail).toContain('30 days');
    expect(
      (await alice.client.patch(`/api/v1/communities/${id}`, { name: 'Taken' })).statusCode,
    ).toBe(403);

    const mine = await alice.client.get('/api/v1/communities');
    expect(mine.json<{ communities: { id: string }[] }>().communities.map((c) => c.id)).toEqual([
      id,
    ]);
    const members = await owner.client.get(`/api/v1/communities/${id}/members`);
    expect(members.json<{ members: { userId: string }[] }>().members).toHaveLength(2);
    expect((await bob.client.get(`/api/v1/communities/${id}/members`)).statusCode).toBe(404);

    // The owner cannot leave; members can.
    expect((await owner.client.post(`/api/v1/communities/${id}/leave`, {})).statusCode).toBe(409);
    expect((await alice.client.post(`/api/v1/communities/${id}/leave`, {})).statusCode).toBe(200);
    expect((await view(alice, id))?.me.member).toBe(false);

    // Only the owner deletes; deleted communities disappear.
    expect((await alice.client.delete(`/api/v1/communities/${hidden}`)).statusCode).toBe(404);
    expect((await owner.client.delete(`/api/v1/communities/${id}`)).statusCode).toBe(200);
    expect(await view(owner, id)).toBeNull();
    const audit = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['communities.created', 'communities.updated', 'communities.deleted']),
    );
  });
});

describe("'communities.create_role', 'communities.update_role', 'communities.delete_role', 'communities.set_member_roles', 'communities.kick', 'communities.ban', 'communities.bans', 'communities.unban' and 'communities.transfer'", () => {
  it('follows the role hierarchy and never grants more than one holds', async () => {
    const [owner, mod, member, other] = [await user(), await user(), await user(), await user()];
    const id = await create(owner);
    for (const u of [mod, member, other]) expect((await join(u, id)).statusCode).toBe(200);

    const role = async (actor: User, body: object) =>
      actor.client.post(`/api/v1/communities/${id}/roles`, body);
    const moderators = (
      await role(owner, {
        name: 'Moderators',
        position: 10,
        permissions:
          COMMUNITY_PERMISSIONS.manageRoles |
          COMMUNITY_PERMISSIONS.kickMembers |
          COMMUNITY_PERMISSIONS.banMembers,
      })
    ).json<{ id: string }>().id;
    const helpers = (await role(owner, { name: 'Helpers', position: 5, permissions: 0 })).json<{
      id: string;
    }>().id;
    expect((await role(owner, { name: 'Helpers', position: 4, permissions: 0 })).statusCode).toBe(
      409,
    );
    const assign = (actor: User, target: User, roleIds: string[]) =>
      actor.client.put(`/api/v1/communities/${id}/members/${target.id}/roles`, { roleIds });
    expect((await assign(owner, mod, [moderators])).statusCode).toBe(200);
    expect((await view(mod, id))?.me).toMatchObject({ rank: 10, roleIds: [moderators] });

    // A moderator manages roles below theirs only, and cannot grant permissions they lack.
    expect((await assign(mod, member, [helpers])).statusCode).toBe(200);
    expect((await assign(mod, member, [moderators])).statusCode).toBe(403);
    expect((await role(mod, { name: 'Peers', position: 10, permissions: 0 })).statusCode).toBe(403);
    expect(
      (
        await role(mod, {
          name: 'Spacers',
          position: 2,
          permissions: COMMUNITY_PERMISSIONS.manageSpaces,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await mod.client.patch(`/api/v1/communities/${id}/roles/${helpers}`, { name: 'Helpful' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await mod.client.patch(`/api/v1/communities/${id}/roles/${moderators}`, { name: 'X' }))
        .statusCode,
    ).toBe(403);

    // Kicks and bans: only members below; never the owner; bans stop rejoining.
    expect(
      (await mod.client.delete(`/api/v1/communities/${id}/members/${owner.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await member.client.delete(`/api/v1/communities/${id}/members/${other.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await mod.client.delete(`/api/v1/communities/${id}/members/${other.id}`)).statusCode,
    ).toBe(200);
    expect((await join(other, id)).statusCode).toBe(200);
    expect(
      (await mod.client.post(`/api/v1/communities/${id}/bans`, { userId: other.id })).statusCode,
    ).toBe(200);
    expect((await join(other, id)).statusCode).toBe(403);
    const bans = await mod.client.get(`/api/v1/communities/${id}/bans`);
    expect(bans.json<{ bans: { userId: string }[] }>().bans.map((b) => b.userId)).toEqual([
      other.id,
    ]);
    expect((await member.client.get(`/api/v1/communities/${id}/bans`)).statusCode).toBe(403);
    expect((await mod.client.delete(`/api/v1/communities/${id}/bans/${other.id}`)).statusCode).toBe(
      200,
    );
    expect((await join(other, id)).statusCode).toBe(200);

    expect((await mod.client.delete(`/api/v1/communities/${id}/roles/${helpers}`)).statusCode).toBe(
      200,
    );
    expect((await view(member, id))?.me.roleIds).toEqual([]);

    // Ownership goes to a member; the old owner can then leave.
    expect(
      (await mod.client.post(`/api/v1/communities/${id}/owner`, { userId: mod.id })).statusCode,
    ).toBe(403);
    expect(
      (await owner.client.post(`/api/v1/communities/${id}/owner`, { userId: mod.id })).statusCode,
    ).toBe(200);
    expect((await view(mod, id))?.me.owner).toBe(true);
    expect((await owner.client.post(`/api/v1/communities/${id}/leave`, {})).statusCode).toBe(200);

    const actions = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('actor_id', 'in', [owner.id, mod.id])
      .execute();
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'communities.roles_changed',
        'communities.member_kicked',
        'communities.member_banned',
        'communities.member_unbanned',
        'communities.ownership_transferred',
      ]),
    );
  });
});

describe("'communities.create_link', 'communities.links', 'communities.revoke_link', 'communities.preview_link' and 'communities.join_link'", () => {
  it('lets people into a private community through a link, within its limits', async () => {
    const [owner, alice, bob, carol] = [await user(), await user(), await user(), await user()];
    const id = await create(owner, { visibility: 'private', rules: 'Private rules' });
    const created = await owner.client.post(`/api/v1/communities/${id}/links`, {
      expiresInHours: 24,
      maxUses: 2,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token, id: linkId } = created.json<{ token: string; id: string }>();
    expect(
      (
        await alice.client.post(`/api/v1/communities/${id}/links`, {
          expiresInHours: 1,
          maxUses: null,
        })
      ).statusCode,
    ).toBe(404);

    const preview = await alice.client.get(`/api/v1/community-invites/${token}`);
    expect(preview.json()).toMatchObject({ id, rules: 'Private rules', alreadyMember: false });
    const joined = await alice.client.post(`/api/v1/community-invites/${token}/join`, {
      rulesVersion: 1,
    });
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toEqual({ id });
    expect((await view(alice, id))?.me.member).toBe(true);
    await bob.client.post(`/api/v1/community-invites/${token}/join`, { rulesVersion: 1 });
    // Used up: invalid for the next person, and gone from the list.
    expect(
      (await carol.client.post(`/api/v1/community-invites/${token}/join`, { rulesVersion: 1 }))
        .statusCode,
    ).toBe(404);
    expect(
      (await owner.client.get(`/api/v1/communities/${id}/links`)).json<{ links: unknown[] }>()
        .links,
    ).toEqual([]);
    const second = (
      await owner.client.post(`/api/v1/communities/${id}/links`, {
        expiresInHours: 1,
        maxUses: null,
      })
    ).json<{ token: string; id: string }>();
    expect(
      (await owner.client.delete(`/api/v1/communities/${id}/links/${second.id}`)).statusCode,
    ).toBe(200);
    expect((await carol.client.get(`/api/v1/community-invites/${second.token}`)).statusCode).toBe(
      404,
    );
    expect(
      (await owner.client.delete(`/api/v1/communities/${id}/links/${linkId}`)).statusCode,
    ).toBe(200);
    // Only a digest of the token is stored.
    const stored = await env.db
      .selectFrom('community_links')
      .select('token_digest')
      .where('id', '=', linkId)
      .executeTakeFirstOrThrow();
    expect(stored.token_digest).toEqual(createHash('sha256').update(token).digest());
  });
});

describe("'communities.create_space', 'communities.spaces', 'communities.join_space', 'communities.delete_space' and 'communities.my_spaces'", () => {
  it('keeps space membership within the community and its roles', async () => {
    const [owner, alice, bob, outsider] = [await user(), await user(), await user(), await user()];
    const id = await create(owner);
    for (const u of [alice, bob]) await join(u, id);
    const crew = (
      await owner.client.post(`/api/v1/communities/${id}/roles`, {
        name: 'Crew',
        position: 3,
        permissions: 0,
      })
    ).json<{ id: string }>().id;
    const space = async (body: object) =>
      owner.client.post(`/api/v1/communities/${id}/spaces`, { ciphersuite: 1, ...body });
    const general = (await space({ name: 'General', roleIds: [], autoApprove: true })).json<{
      id: string;
    }>().id;
    const backstage = (
      await space({ name: 'Backstage', roleIds: [crew], autoApprove: false })
    ).json<{
      id: string;
    }>().id;
    expect((await space({ name: 'General', roleIds: [], autoApprove: true })).statusCode).toBe(409);
    expect(
      (
        await alice.client.post(`/api/v1/communities/${id}/spaces`, {
          name: 'Mine',
          roleIds: [],
          autoApprove: true,
          ciphersuite: 1,
        })
      ).statusCode,
    ).toBe(403);
    // The creator owns the space's group.
    expect(await inSpace(owner, general)).toBe(true);

    // Restricted spaces are invisible to members without the role.
    const visible = async (u: User) =>
      spaceListSchema
        .parse((await u.client.get(`/api/v1/communities/${id}/spaces`)).json())
        .spaces.map((s) => s.name);
    expect(await visible(alice)).toEqual(['General']);
    expect(await visible(owner)).toEqual(['Backstage', 'General']);
    expect((await outsider.client.get(`/api/v1/communities/${id}/spaces`)).statusCode).toBe(404);

    // Joining a space is a request that the space's admin device approves end to end.
    const ask = (u: User, s: string) =>
      u.client.post(`/api/v1/communities/${id}/spaces/${s}/join`, {});
    expect((await ask(alice, general)).json()).toEqual({ status: 'requested' });
    expect((await ask(alice, backstage)).statusCode).toBe(403);
    expect((await ask(outsider, general)).statusCode).toBe(404);
    const approve = await owner.client.post(
      `/api/v1/groups/${general}/requests/${alice.id}/approve`,
      {},
    );
    expect(approve.statusCode, approve.body).toBe(200);
    expect(await inSpace(alice, general)).toBe(true);
    expect((await ask(alice, general)).json()).toEqual({ status: 'member' });
    const labels = await alice.client.get('/api/v1/community-spaces');
    expect(labels.json()).toEqual({
      spaces: [
        expect.objectContaining({ conversationId: general, name: 'General', communityId: id }),
      ],
    });

    // Group adds are limited to eligible community members, whatever path is used.
    const add = await owner.client.post(`/api/v1/groups/${general}/members`, {
      usernames: [outsider.username],
    });
    expect(add.json()).toMatchObject({ skipped: [{ reason: 'not_allowed' }] });

    // Losing the role (or the community) takes people out of the spaces they no longer qualify for.
    await owner.client.put(`/api/v1/communities/${id}/members/${bob.id}/roles`, {
      roleIds: [crew],
    });
    await ask(bob, backstage);
    await owner.client.post(`/api/v1/groups/${backstage}/requests/${bob.id}/approve`, {});
    expect(await inSpace(bob, backstage)).toBe(true);
    await owner.client.put(`/api/v1/communities/${id}/members/${bob.id}/roles`, { roleIds: [] });
    expect(await inSpace(bob, backstage)).toBe(false);
    await alice.client.post(`/api/v1/communities/${id}/leave`, {});
    expect(await inSpace(alice, general)).toBe(false);

    // Deleting a space deletes its group; deleting the community deletes them all.
    expect(
      (await owner.client.delete(`/api/v1/communities/${id}/spaces/${backstage}`)).statusCode,
    ).toBe(200);
    expect(await inSpace(owner, backstage)).toBe(false);
    await owner.client.delete(`/api/v1/communities/${id}`);
    expect(await inSpace(owner, general)).toBe(false);
  });
});
