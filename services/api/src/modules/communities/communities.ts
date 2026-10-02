import { createHash, randomBytes } from 'node:crypto';

import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  ALL_COMMUNITY_PERMISSIONS,
  COMMUNITY_PERMISSIONS,
  MAX_COMMUNITY_MEMBERS,
  MAX_COMMUNITY_ROLES,
  MAX_COMMUNITY_SPACES,
  type CommunityPermission,
  type communityBanListSchema,
  type communityInvitePreviewSchema,
  type communityLinkListSchema,
  type communityListSchema,
  type communityMemberListSchema,
  type communitySchema,
  type createCommunityLinkSchema,
  type createCommunityRoleSchema,
  type createCommunitySchema,
  type createSpaceSchema,
  type createdCommunityLinkSchema,
  type mySpacesSchema,
  type spaceListSchema,
  type updateCommunityRoleSchema,
  type updateCommunitySchema,
} from '@tessera/validation';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { z } from 'zod';

import type { Database } from '../../db/schema.js';
import type { RealtimePublisher } from '../../platform/realtime-publisher.js';
import type { AuditLog } from '../audit/index.js';

/**
 * Communities (docs/groups.md §5, ADR-045): a server-known container with rules, a verification
 * gate, roles (permission bitset ordered by position) and spaces. Spaces are end-to-end encrypted
 * groups owned by the messaging module; this module decides who is *eligible* to be in them and
 * takes people out when they leave the community or lose a role. Adding someone to a space's
 * encryption group is always done by a space admin's device (an encrypted intent, ADR-044).
 */

export interface CommunityDirectory {
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
  accountCreatedAt(userId: string): Promise<Date | null>;
}

/** What communities need from groups (implemented by the messaging module's GroupsService). */
export interface SpaceGroups {
  createSpace(actor: string, ciphersuite: number): Promise<string>;
  requestSpaceJoin(userId: string, groupId: string): Promise<'member' | 'requested'>;
  spaceStatus(
    userId: string,
    groupIds: readonly string[],
  ): Promise<{ joined: Set<string>; requested: Set<string> }>;
  removeFromGroups(userIds: readonly string[], groupIds: readonly string[]): Promise<void>;
  deleteGroups(groupIds: readonly string[]): Promise<void>;
}

type Executor = Kysely<Database> | Transaction<Database>;
type CreateInput = z.infer<typeof createCommunitySchema>;
type UpdateInput = z.infer<typeof updateCommunitySchema>;

const DAY_MS = 24 * 60 * 60_000;
/** Above every role position (1–1000). */
const OWNER_RANK = 1001;
const MAX_OWNED = 20;
const DIRECTORY_LIMIT = 30;
const MEMBER_PAGE = 200;

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

interface Standing {
  readonly owner: boolean;
  readonly permissions: number;
  readonly rank: number;
  readonly roleIds: string[];
}

export class CommunitiesService {
  readonly #db: Kysely<Database>;
  readonly #directory: CommunityDirectory;
  readonly #groups: SpaceGroups;
  readonly #publisher: RealtimePublisher;
  readonly #audit: AuditLog;
  readonly #logger: Logger;

  constructor(
    db: Kysely<Database>,
    directory: CommunityDirectory,
    groups: SpaceGroups,
    publisher: RealtimePublisher,
    audit: AuditLog,
    logger: Logger,
  ) {
    this.#db = db;
    this.#directory = directory;
    this.#groups = groups;
    this.#publisher = publisher;
    this.#audit = audit;
    this.#logger = logger;
  }

  // ---- helpers ---------------------------------------------------------------------------------

  async #community(executor: Executor, id: string, lock = false) {
    let query = executor
      .selectFrom('communities')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  async #isMember(executor: Executor, communityId: string, userId: string): Promise<boolean> {
    const row = await executor
      .selectFrom('community_members')
      .select('user_id')
      .where('community_id', '=', communityId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async #isBanned(executor: Executor, communityId: string, userId: string): Promise<boolean> {
    const row = await executor
      .selectFrom('community_bans')
      .select('user_id')
      .where('community_id', '=', communityId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** A member's permissions and rank (null for non-members). */
  async #standing(
    executor: Executor,
    community: { id: string; owner_id: string },
    userId: string,
  ): Promise<Standing | null> {
    if (!(await this.#isMember(executor, community.id, userId))) return null;
    const roles = await executor
      .selectFrom('community_member_roles')
      .innerJoin('community_roles', 'community_roles.id', 'community_member_roles.role_id')
      .select(['community_roles.id', 'community_roles.position', 'community_roles.permissions'])
      .where('community_member_roles.community_id', '=', community.id)
      .where('community_member_roles.user_id', '=', userId)
      .execute();
    const owner = community.owner_id === userId;
    return {
      owner,
      permissions: owner
        ? ALL_COMMUNITY_PERMISSIONS
        : roles.reduce((bits, role) => bits | role.permissions, 0),
      rank: owner ? OWNER_RANK : Math.max(0, ...roles.map((role) => role.position)),
      roleIds: roles.map((role) => role.id),
    };
  }

  async #require(
    executor: Executor,
    community: { id: string; owner_id: string },
    userId: string,
    permission?: CommunityPermission,
  ): Promise<Standing> {
    const standing = await this.#standing(executor, community, userId);
    if (standing === null) throw new AppError('NOT_FOUND');
    if (
      permission !== undefined &&
      (standing.permissions & COMMUNITY_PERMISSIONS[permission]) === 0
    )
      throw new AppError('FORBIDDEN', { detail: 'Your community role does not allow this.' });
    return standing;
  }

  async #memberIds(executor: Executor, communityId: string): Promise<string[]> {
    const rows = await executor
      .selectFrom('community_members')
      .select('user_id')
      .where('community_id', '=', communityId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  async #memberCount(executor: Executor, communityId: string): Promise<number> {
    const row = await executor
      .selectFrom('community_members')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('community_id', '=', communityId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async #spaceIds(executor: Executor, communityId: string): Promise<string[]> {
    const rows = await executor
      .selectFrom('community_spaces')
      .select('conversation_id')
      .where('community_id', '=', communityId)
      .execute();
    return rows.map((row) => row.conversation_id);
  }

  /** Tells members something changed (best effort; clients re-fetch). */
  async #notifyMembers(communityId: string, extra: readonly string[] = []): Promise<void> {
    const members = await this.#memberIds(this.#db, communityId);
    const all = [...new Set([...members, ...extra])];
    if (all.length > 0) this.#publisher.publish(all, { type: 'community', communityId });
  }

  /**
   * Verification gate (docs/groups.md §5): not banned, account old enough, current rules
   * accepted, room left. Evaluated by the server before anyone becomes a member.
   */
  async #admit(
    trx: Transaction<Database>,
    community: { id: string; rules_version: number; min_account_age_days: number },
    userId: string,
    rulesVersion: number,
  ): Promise<void> {
    if (await this.#isBanned(trx, community.id, userId))
      throw new AppError('FORBIDDEN', { detail: 'You cannot join this community.' });
    if (rulesVersion !== community.rules_version)
      throw new AppError('CONFLICT', {
        detail: 'The rules changed. Read them again before joining.',
      });
    const createdAt = await this.#directory.accountCreatedAt(userId);
    if (createdAt === null) throw new AppError('NOT_FOUND');
    if (Date.now() - createdAt.getTime() < community.min_account_age_days * DAY_MS)
      throw new AppError('FORBIDDEN', {
        detail: `Accounts must be at least ${community.min_account_age_days} days old to join.`,
      });
    if ((await this.#memberCount(trx, community.id)) >= MAX_COMMUNITY_MEMBERS)
      throw new AppError('CONFLICT', { detail: 'This community is full.' });
    await trx
      .insertInto('community_members')
      .values({ community_id: community.id, user_id: userId, rules_version: rulesVersion })
      .onConflict((oc) => oc.columns(['community_id', 'user_id']).doNothing())
      .execute();
  }

  /** Spaces of a community this member may not be in (restricted to roles they lack). */
  async #ineligibleSpaces(
    executor: Executor,
    community: { id: string; owner_id: string },
    userId: string,
  ): Promise<string[]> {
    const standing = await this.#standing(executor, community, userId);
    const spaces = await this.#spaceIds(executor, community.id);
    if (standing === null) return spaces;
    if (standing.owner || spaces.length === 0) return [];
    const restrictions = await executor
      .selectFrom('community_space_roles')
      .select(['conversation_id', 'role_id'])
      .where('conversation_id', 'in', spaces)
      .execute();
    const byRole = new Map<string, string[]>();
    for (const row of restrictions)
      byRole.set(row.conversation_id, [...(byRole.get(row.conversation_id) ?? []), row.role_id]);
    return [...byRole]
      .filter(([, roles]) => !roles.some((role) => standing.roleIds.includes(role)))
      .map(([spaceId]) => spaceId);
  }

  async #removeFromIneligibleSpaces(
    community: { id: string; owner_id: string },
    userId: string,
  ): Promise<void> {
    const spaces = await this.#ineligibleSpaces(this.#db, community, userId);
    await this.#groups.removeFromGroups([userId], spaces);
  }

  // ---- space eligibility (SpaceGate for the messaging module) -----------------------------------

  async mayJoin(groupId: string, userId: string): Promise<boolean | null> {
    const space = await this.#db
      .selectFrom('community_spaces')
      .innerJoin('communities', 'communities.id', 'community_spaces.community_id')
      .select(['communities.id', 'communities.owner_id', 'communities.deleted_at'])
      .where('community_spaces.conversation_id', '=', groupId)
      .executeTakeFirst();
    if (space === undefined) return null;
    if (space.deleted_at !== null) return false;
    if (await this.#isBanned(this.#db, space.id, userId)) return false;
    if (!(await this.#isMember(this.#db, space.id, userId))) return false;
    return !(await this.#ineligibleSpaces(this.#db, space, userId)).includes(groupId);
  }

  // ---- communities -----------------------------------------------------------------------------

  async create(actor: string, input: CreateInput, requestId?: string): Promise<string> {
    const id = newId();
    await this.#db.transaction().execute(async (trx) => {
      const owned = await trx
        .selectFrom('communities')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('owner_id', '=', actor)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(owned.count) >= MAX_OWNED)
        throw new AppError('CONFLICT', { detail: `You can own up to ${MAX_OWNED} communities.` });
      await trx
        .insertInto('communities')
        .values({
          id,
          name: input.name,
          description: input.description,
          visibility: input.visibility,
          rules: input.rules,
          min_account_age_days: input.minAccountAgeDays,
          owner_id: actor,
        })
        .execute();
      await trx
        .insertInto('community_members')
        .values({ community_id: id, user_id: actor, rules_version: 1 })
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: actor,
          action: 'communities.created',
          targetKind: 'community',
          targetId: id,
          ...(requestId === undefined ? {} : { requestId }),
          details: { visibility: input.visibility },
        },
        trx,
      );
    });
    return id;
  }

  async get(viewer: string, id: string): Promise<z.infer<typeof communitySchema>> {
    const community = await this.#community(this.#db, id);
    const standing = await this.#standing(this.#db, community, viewer);
    const banned = await this.#isBanned(this.#db, id, viewer);
    // Private communities do not exist for non-members (they join through an invite link).
    if (standing === null && community.visibility === 'private') throw new AppError('NOT_FOUND');
    const roles = await this.#db
      .selectFrom('community_roles')
      .select(['id', 'name', 'position', 'permissions'])
      .where('community_id', '=', id)
      .orderBy('position', 'desc')
      .execute();
    return {
      id,
      name: community.name,
      description: community.description,
      visibility: community.visibility,
      memberCount: await this.#memberCount(this.#db, id),
      rules: community.rules,
      rulesVersion: community.rules_version,
      minAccountAgeDays: community.min_account_age_days,
      ownerId: community.owner_id,
      createdAt: community.created_at.toISOString(),
      roles,
      me: {
        member: standing !== null,
        owner: standing?.owner ?? false,
        banned,
        permissions: standing?.permissions ?? 0,
        roleIds: standing?.roleIds ?? [],
        rank: standing?.rank ?? 0,
      },
    };
  }

  async #summaries(rows: readonly { id: string }[]): Promise<z.infer<typeof communityListSchema>> {
    if (rows.length === 0) return { communities: [] };
    const ids = rows.map((row) => row.id);
    const details = await this.#db
      .selectFrom('communities')
      .leftJoin('community_members', 'community_members.community_id', 'communities.id')
      .select([
        'communities.id',
        'communities.name',
        'communities.description',
        'communities.visibility',
        (eb) => eb.fn.count<string>('community_members.user_id').as('members'),
      ])
      .where('communities.id', 'in', ids)
      .groupBy('communities.id')
      .execute();
    const byId = new Map(details.map((row) => [row.id, row]));
    return {
      communities: ids.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined
          ? []
          : [
              {
                id,
                name: row.name,
                description: row.description,
                visibility: row.visibility,
                memberCount: Number(row.members),
              },
            ];
      }),
    };
  }

  async mine(userId: string): Promise<z.infer<typeof communityListSchema>> {
    const rows = await this.#db
      .selectFrom('community_members')
      .innerJoin('communities', 'communities.id', 'community_members.community_id')
      .select('communities.id')
      .where('community_members.user_id', '=', userId)
      .where('communities.deleted_at', 'is', null)
      .orderBy('communities.name')
      .execute();
    return this.#summaries(rows);
  }

  /** Public directory (server-readable data only): name match, largest first. */
  async discover(query: string): Promise<z.infer<typeof communityListSchema>> {
    const escaped = query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.#db
      .selectFrom('communities')
      .leftJoin('community_members', 'community_members.community_id', 'communities.id')
      .select('communities.id')
      .where('communities.visibility', '=', 'public')
      .where('communities.deleted_at', 'is', null)
      .where(sql<boolean>`lower(communities.name) LIKE ${`%${escaped}%`} ESCAPE '\\'`)
      .groupBy('communities.id')
      .orderBy(sql`count(community_members.user_id)`, 'desc')
      .orderBy('communities.name')
      .limit(DIRECTORY_LIMIT)
      .execute();
    return this.#summaries(rows);
  }

  async update(actor: string, id: string, patch: UpdateInput, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      await this.#require(trx, community, actor, 'manageCommunity');
      const rulesChanged = patch.rules !== undefined && patch.rules !== community.rules;
      await trx
        .updateTable('communities')
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
          ...(patch.minAccountAgeDays === undefined
            ? {}
            : { min_account_age_days: patch.minAccountAgeDays }),
          ...(rulesChanged
            ? { rules: patch.rules, rules_version: community.rules_version + 1 }
            : {}),
        })
        .where('id', '=', id)
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: actor,
          action: 'communities.updated',
          targetKind: 'community',
          targetId: id,
          ...(requestId === undefined ? {} : { requestId }),
          details: { fields: Object.keys(patch).sort().join(','), rulesChanged },
        },
        trx,
      );
    });
    await this.#notifyMembers(id);
  }

  async delete(actor: string, id: string, requestId?: string): Promise<void> {
    const { spaces, members } = await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      await this.#require(trx, community, actor); // non-members: 404, as if it did not exist
      if (community.owner_id !== actor)
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can delete the community.' });
      const members = await this.#memberIds(trx, id);
      const spaces = await this.#spaceIds(trx, id);
      await trx
        .updateTable('communities')
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .execute();
      await trx
        .updateTable('community_links')
        .set({ revoked_at: new Date() })
        .where('community_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: actor,
          action: 'communities.deleted',
          targetKind: 'community',
          targetId: id,
          ...(requestId === undefined ? {} : { requestId }),
          details: { spaces: spaces.length },
        },
        trx,
      );
      return { spaces, members };
    });
    await this.#groups.deleteGroups(spaces);
    if (members.length > 0)
      this.#publisher.publish(members, { type: 'community', communityId: id });
  }

  async join(userId: string, id: string, rulesVersion: number): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      if (await this.#isMember(trx, id, userId)) return;
      if (community.visibility !== 'public') throw new AppError('NOT_FOUND');
      await this.#admit(trx, community, userId, rulesVersion);
    });
    this.#publisher.publish([userId], { type: 'community', communityId: id });
  }

  async leave(userId: string, id: string): Promise<void> {
    const spaces = await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      if (!(await this.#isMember(trx, id, userId))) throw new AppError('NOT_FOUND');
      if (community.owner_id === userId)
        throw new AppError('CONFLICT', {
          detail: 'Hand the community to another member, or delete it, before leaving.',
        });
      await trx
        .deleteFrom('community_members')
        .where('community_id', '=', id)
        .where('user_id', '=', userId)
        .execute();
      return this.#spaceIds(trx, id);
    });
    await this.#groups.removeFromGroups([userId], spaces);
    this.#publisher.publish([userId], { type: 'community', communityId: id });
  }

  async members(
    viewer: string,
    id: string,
    cursor: string | undefined,
  ): Promise<z.infer<typeof communityMemberListSchema>> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, viewer);
    let query = this.#db
      .selectFrom('community_members')
      .select(['user_id', 'joined_at'])
      .where('community_id', '=', id)
      .orderBy('user_id')
      .limit(MEMBER_PAGE + 1);
    if (cursor !== undefined) query = query.where('user_id', '>', cursor);
    const rows = await query.execute();
    const page = rows.slice(0, MEMBER_PAGE);
    const ids = page.map((row) => row.user_id);
    const [names, roles] = await Promise.all([
      this.#directory.usernames(ids),
      ids.length === 0
        ? Promise.resolve([])
        : this.#db
            .selectFrom('community_member_roles')
            .select(['user_id', 'role_id'])
            .where('community_id', '=', id)
            .where('user_id', 'in', ids)
            .execute(),
    ]);
    return {
      members: page.map((row) => ({
        userId: row.user_id,
        username: names.get(row.user_id) ?? 'deleted',
        roleIds: roles.filter((role) => role.user_id === row.user_id).map((role) => role.role_id),
        owner: row.user_id === community.owner_id,
        joinedAt: row.joined_at.toISOString(),
      })),
      nextCursor: rows.length > MEMBER_PAGE ? (page.at(-1)?.user_id ?? null) : null,
    };
  }

  async transfer(actor: string, id: string, target: string, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      await this.#require(trx, community, actor);
      if (community.owner_id !== actor)
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can hand over the community.' });
      if (target === actor || !(await this.#isMember(trx, id, target)))
        throw new AppError('BAD_REQUEST', { detail: 'Choose another member of the community.' });
      await trx.updateTable('communities').set({ owner_id: target }).where('id', '=', id).execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: actor,
          action: 'communities.ownership_transferred',
          targetKind: 'community',
          targetId: id,
          ...(requestId === undefined ? {} : { requestId }),
          details: { to: target },
        },
        trx,
      );
    });
    await this.#notifyMembers(id);
  }

  // ---- roles -----------------------------------------------------------------------------------

  async createRole(
    actor: string,
    id: string,
    input: z.infer<typeof createCommunityRoleSchema>,
    requestId?: string,
  ): Promise<string> {
    const roleId = newId();
    await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      const me = await this.#require(trx, community, actor, 'manageRoles');
      this.#checkRoleChange(me, input.position, input.permissions);
      const count = await trx
        .selectFrom('community_roles')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('community_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_COMMUNITY_ROLES)
        throw new AppError('CONFLICT', { detail: `Up to ${MAX_COMMUNITY_ROLES} roles.` });
      const taken = await trx
        .selectFrom('community_roles')
        .select('id')
        .where('community_id', '=', id)
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (taken !== undefined)
        throw new AppError('CONFLICT', { detail: 'A role with this name exists.' });
      await trx
        .insertInto('community_roles')
        .values({
          id: roleId,
          community_id: id,
          name: input.name,
          position: input.position,
          permissions: input.permissions,
        })
        .execute();
      await this.#auditRoles(trx, actor, id, 'created', roleId, requestId);
    });
    await this.#notifyMembers(id);
    return roleId;
  }

  /** Roles are managed only below one's own rank, and never grant more than one holds. */
  #checkRoleChange(me: Standing, position: number, permissions: number): void {
    if (position >= me.rank)
      throw new AppError('FORBIDDEN', {
        detail: 'You can only manage roles below your highest role.',
      });
    if (!me.owner && (permissions & ~me.permissions) !== 0)
      throw new AppError('FORBIDDEN', {
        detail: 'You cannot grant permissions you do not have.',
      });
  }

  async #role(executor: Executor, id: string, roleId: string) {
    const role = await executor
      .selectFrom('community_roles')
      .selectAll()
      .where('community_id', '=', id)
      .where('id', '=', roleId)
      .executeTakeFirst();
    if (role === undefined) throw new AppError('NOT_FOUND');
    return role;
  }

  async #auditRoles(
    trx: Transaction<Database>,
    actor: string,
    id: string,
    change: string,
    target: string,
    requestId?: string,
  ): Promise<void> {
    await this.#audit.record(
      {
        actorKind: 'user',
        actorId: actor,
        action: 'communities.roles_changed',
        targetKind: 'community',
        targetId: id,
        ...(requestId === undefined ? {} : { requestId }),
        details: { change, target },
      },
      trx,
    );
  }

  async updateRole(
    actor: string,
    id: string,
    roleId: string,
    patch: z.infer<typeof updateCommunityRoleSchema>,
    requestId?: string,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      const me = await this.#require(trx, community, actor, 'manageRoles');
      const role = await this.#role(trx, id, roleId);
      this.#checkRoleChange(me, role.position, role.permissions);
      this.#checkRoleChange(
        me,
        patch.position ?? role.position,
        patch.permissions ?? role.permissions,
      );
      await trx
        .updateTable('community_roles')
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.position === undefined ? {} : { position: patch.position }),
          ...(patch.permissions === undefined ? {} : { permissions: patch.permissions }),
        })
        .where('id', '=', roleId)
        .execute();
      await this.#auditRoles(trx, actor, id, 'updated', roleId, requestId);
    });
    await this.#notifyMembers(id);
  }

  async deleteRole(actor: string, id: string, roleId: string, requestId?: string): Promise<void> {
    const { community, holders } = await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      const me = await this.#require(trx, community, actor, 'manageRoles');
      const role = await this.#role(trx, id, roleId);
      this.#checkRoleChange(me, role.position, role.permissions);
      const holders = await trx
        .selectFrom('community_member_roles')
        .select('user_id')
        .where('role_id', '=', roleId)
        .execute();
      await trx.deleteFrom('community_roles').where('id', '=', roleId).execute();
      await this.#auditRoles(trx, actor, id, 'deleted', roleId, requestId);
      return { community, holders: holders.map((row) => row.user_id) };
    });
    for (const userId of holders) await this.#removeFromIneligibleSpaces(community, userId);
    await this.#notifyMembers(id);
  }

  async setMemberRoles(
    actor: string,
    id: string,
    target: string,
    roleIds: readonly string[],
    requestId?: string,
  ): Promise<void> {
    const community = await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      const me = await this.#require(trx, community, actor, 'manageRoles');
      const them = await this.#standing(trx, community, target);
      if (them === null) throw new AppError('NOT_FOUND');
      if (them.owner || (target !== actor && them.rank >= me.rank))
        throw new AppError('FORBIDDEN', {
          detail: 'You can only change the roles of members below you.',
        });
      const wanted = [...new Set(roleIds)];
      const roles =
        wanted.length === 0
          ? []
          : await trx
              .selectFrom('community_roles')
              .select(['id', 'position'])
              .where('community_id', '=', id)
              .where('id', 'in', wanted)
              .execute();
      if (roles.length !== wanted.length) throw new AppError('NOT_FOUND');
      const current = await trx
        .selectFrom('community_member_roles')
        .innerJoin('community_roles', 'community_roles.id', 'community_member_roles.role_id')
        .select(['community_roles.id', 'community_roles.position'])
        .where('community_member_roles.community_id', '=', id)
        .where('community_member_roles.user_id', '=', target)
        .execute();
      const changed = [
        ...roles.filter((role) => !current.some((c) => c.id === role.id)),
        ...current.filter((c) => !wanted.includes(c.id)),
      ];
      if (changed.some((role) => role.position >= me.rank))
        throw new AppError('FORBIDDEN', {
          detail: 'You can only assign roles below your highest role.',
        });
      await trx
        .deleteFrom('community_member_roles')
        .where('community_id', '=', id)
        .where('user_id', '=', target)
        .execute();
      if (wanted.length > 0)
        await trx
          .insertInto('community_member_roles')
          .values(wanted.map((roleId) => ({ community_id: id, user_id: target, role_id: roleId })))
          .execute();
      await this.#auditRoles(trx, actor, id, 'member_roles', target, requestId);
      return community;
    });
    await this.#removeFromIneligibleSpaces(community, target);
    await this.#notifyMembers(id);
  }

  // ---- moderation ------------------------------------------------------------------------------

  async remove(
    actor: string,
    id: string,
    target: string,
    ban: boolean,
    requestId?: string,
  ): Promise<void> {
    const spaces = await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      const me = await this.#require(trx, community, actor, ban ? 'banMembers' : 'kickMembers');
      if (target === actor)
        throw new AppError('BAD_REQUEST', { detail: 'Leave the community instead.' });
      const them = await this.#standing(trx, community, target);
      if (them === null && !ban) throw new AppError('NOT_FOUND');
      if (them !== null && (them.owner || them.rank >= me.rank))
        throw new AppError('FORBIDDEN', { detail: 'You can only remove members below you.' });
      await trx
        .deleteFrom('community_members')
        .where('community_id', '=', id)
        .where('user_id', '=', target)
        .execute();
      if (ban)
        await trx
          .insertInto('community_bans')
          .values({ community_id: id, user_id: target, banned_by: actor })
          .onConflict((oc) => oc.columns(['community_id', 'user_id']).doNothing())
          .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: actor,
          action: ban ? 'communities.member_banned' : 'communities.member_kicked',
          targetKind: 'user',
          targetId: target,
          ...(requestId === undefined ? {} : { requestId }),
          details: { community: id },
        },
        trx,
      );
      return this.#spaceIds(trx, id);
    });
    await this.#groups.removeFromGroups([target], spaces);
    this.#publisher.publish([target], { type: 'community', communityId: id });
    await this.#notifyMembers(id);
  }

  async bans(actor: string, id: string): Promise<z.infer<typeof communityBanListSchema>> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, actor, 'banMembers');
    const rows = await this.#db
      .selectFrom('community_bans')
      .select(['user_id', 'created_at'])
      .where('community_id', '=', id)
      .orderBy('created_at', 'desc')
      .limit(500)
      .execute();
    const names = await this.#directory.usernames(rows.map((row) => row.user_id));
    return {
      bans: rows.map((row) => ({
        userId: row.user_id,
        username: names.get(row.user_id) ?? 'deleted',
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async unban(actor: string, id: string, target: string, requestId?: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const community = await this.#community(trx, id, true);
      await this.#require(trx, community, actor, 'banMembers');
      const deleted = await trx
        .deleteFrom('community_bans')
        .where('community_id', '=', id)
        .where('user_id', '=', target)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: actor,
          action: 'communities.member_unbanned',
          targetKind: 'user',
          targetId: target,
          ...(requestId === undefined ? {} : { requestId }),
          details: { community: id },
        },
        trx,
      );
    });
  }

  // ---- invite links ----------------------------------------------------------------------------

  async createLink(
    actor: string,
    id: string,
    input: z.infer<typeof createCommunityLinkSchema>,
  ): Promise<z.infer<typeof createdCommunityLinkSchema>> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, actor, 'createInvites');
    const token = randomBytes(16).toString('base64url');
    const row = await this.#db
      .insertInto('community_links')
      .values({
        id: newId(),
        community_id: id,
        token_digest: digest(token),
        created_by: actor,
        expires_at: new Date(Date.now() + input.expiresInHours * 3_600_000),
        max_uses: input.maxUses,
      })
      .returning(['id', 'expires_at', 'max_uses', 'uses', 'created_at'])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      token,
      expiresAt: row.expires_at.toISOString(),
      maxUses: row.max_uses,
      uses: row.uses,
      createdAt: row.created_at.toISOString(),
    };
  }

  async links(actor: string, id: string): Promise<z.infer<typeof communityLinkListSchema>> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, actor, 'createInvites');
    const rows = await this.#db
      .selectFrom('community_links')
      .select(['id', 'expires_at', 'max_uses', 'uses', 'created_at'])
      .where('community_id', '=', id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where((eb) => eb.or([eb('max_uses', 'is', null), eb('uses', '<', eb.ref('max_uses'))]))
      .orderBy('created_at', 'desc')
      .execute();
    return {
      links: rows.map((row) => ({
        id: row.id,
        expiresAt: row.expires_at.toISOString(),
        maxUses: row.max_uses,
        uses: row.uses,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async revokeLink(actor: string, id: string, linkId: string): Promise<void> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, actor, 'createInvites');
    const result = await this.#db
      .updateTable('community_links')
      .set({ revoked_at: new Date() })
      .where('id', '=', linkId)
      .where('community_id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new AppError('NOT_FOUND');
  }

  async #liveLink(executor: Executor, token: string, lock = false) {
    let query = executor
      .selectFrom('community_links')
      .selectAll()
      .where('token_digest', '=', digest(token))
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date());
    if (lock) query = query.forUpdate();
    const link = await query.executeTakeFirst();
    if (link === undefined || (link.max_uses !== null && link.uses >= link.max_uses))
      throw new AppError('NOT_FOUND', { detail: 'This invite link is invalid or has expired.' });
    return link;
  }

  async previewLink(
    userId: string,
    token: string,
  ): Promise<z.infer<typeof communityInvitePreviewSchema>> {
    const link = await this.#liveLink(this.#db, token);
    const community = await this.#community(this.#db, link.community_id);
    return {
      id: community.id,
      name: community.name,
      description: community.description,
      visibility: community.visibility,
      memberCount: await this.#memberCount(this.#db, community.id),
      rules: community.rules,
      rulesVersion: community.rules_version,
      minAccountAgeDays: community.min_account_age_days,
      alreadyMember: await this.#isMember(this.#db, community.id, userId),
    };
  }

  async joinViaLink(userId: string, token: string, rulesVersion: number): Promise<string> {
    const communityId = await this.#db.transaction().execute(async (trx) => {
      const link = await this.#liveLink(trx, token, true);
      const community = await this.#community(trx, link.community_id, true);
      if (await this.#isMember(trx, community.id, userId)) return community.id;
      await this.#admit(trx, community, userId, rulesVersion);
      await trx
        .updateTable('community_links')
        .set({ uses: link.uses + 1 })
        .where('id', '=', link.id)
        .execute();
      return community.id;
    });
    this.#publisher.publish([userId], { type: 'community', communityId });
    return communityId;
  }

  // ---- spaces ----------------------------------------------------------------------------------

  async createSpace(
    actor: string,
    id: string,
    input: z.infer<typeof createSpaceSchema>,
  ): Promise<string> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, actor, 'manageSpaces');
    const spaces = await this.#spaceIds(this.#db, id);
    if (spaces.length >= MAX_COMMUNITY_SPACES)
      throw new AppError('CONFLICT', { detail: `Up to ${MAX_COMMUNITY_SPACES} spaces.` });
    const roleIds = [...new Set(input.roleIds)];
    if (roleIds.length > 0) {
      const found = await this.#db
        .selectFrom('community_roles')
        .select('id')
        .where('community_id', '=', id)
        .where('id', 'in', roleIds)
        .execute();
      if (found.length !== roleIds.length) throw new AppError('NOT_FOUND');
    }
    const taken = await this.#db
      .selectFrom('community_spaces')
      .select('conversation_id')
      .where('community_id', '=', id)
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (taken !== undefined)
      throw new AppError('CONFLICT', { detail: 'A space with this name exists.' });
    const groupId = await this.#groups.createSpace(actor, input.ciphersuite);
    try {
      await this.#db.transaction().execute(async (trx) => {
        await trx
          .insertInto('community_spaces')
          .values({
            conversation_id: groupId,
            community_id: id,
            name: input.name,
            auto_approve: input.autoApprove,
          })
          .execute();
        if (roleIds.length > 0)
          await trx
            .insertInto('community_space_roles')
            .values(roleIds.map((roleId) => ({ conversation_id: groupId, role_id: roleId })))
            .execute();
      });
    } catch (error) {
      await this.#groups.deleteGroups([groupId]).catch((cleanup: unknown) => {
        this.#logger.warn(
          'communities.orphan_space_cleanup_failed',
          this.#logger.errorFields(cleanup),
        );
      });
      throw error;
    }
    await this.#notifyMembers(id);
    return groupId;
  }

  async spaces(viewer: string, id: string): Promise<z.infer<typeof spaceListSchema>> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, viewer);
    const rows = await this.#db
      .selectFrom('community_spaces')
      .select(['conversation_id', 'name', 'auto_approve'])
      .where('community_id', '=', id)
      .orderBy('name')
      .execute();
    const ids = rows.map((row) => row.conversation_id);
    const restrictions =
      ids.length === 0
        ? []
        : await this.#db
            .selectFrom('community_space_roles')
            .select(['conversation_id', 'role_id'])
            .where('conversation_id', 'in', ids)
            .execute();
    const hidden = new Set(await this.#ineligibleSpaces(this.#db, community, viewer));
    const visible = rows.filter((row) => !hidden.has(row.conversation_id));
    const status = await this.#groups.spaceStatus(
      viewer,
      visible.map((row) => row.conversation_id),
    );
    return {
      spaces: visible.map((row) => ({
        id: row.conversation_id,
        name: row.name,
        roleIds: restrictions
          .filter((r) => r.conversation_id === row.conversation_id)
          .map((r) => r.role_id),
        autoApprove: row.auto_approve,
        joined: status.joined.has(row.conversation_id),
        requested: status.requested.has(row.conversation_id),
      })),
    };
  }

  async #space(executor: Executor, id: string, spaceId: string) {
    const space = await executor
      .selectFrom('community_spaces')
      .selectAll()
      .where('community_id', '=', id)
      .where('conversation_id', '=', spaceId)
      .executeTakeFirst();
    if (space === undefined) throw new AppError('NOT_FOUND');
    return space;
  }

  async deleteSpace(actor: string, id: string, spaceId: string): Promise<void> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, actor, 'manageSpaces');
    await this.#space(this.#db, id, spaceId);
    await this.#groups.deleteGroups([spaceId]);
    await this.#db.deleteFrom('community_spaces').where('conversation_id', '=', spaceId).execute();
    await this.#notifyMembers(id);
  }

  async joinSpace(userId: string, id: string, spaceId: string): Promise<'member' | 'requested'> {
    const community = await this.#community(this.#db, id);
    await this.#require(this.#db, community, userId);
    await this.#space(this.#db, id, spaceId);
    return this.#groups.requestSpaceJoin(userId, spaceId);
  }

  /** The caller's spaces with their community, so clients can label those conversations. */
  async mySpaces(userId: string): Promise<z.infer<typeof mySpacesSchema>> {
    const rows = await this.#db
      .selectFrom('community_spaces')
      .innerJoin('communities', 'communities.id', 'community_spaces.community_id')
      .innerJoin('community_members', (join) =>
        join
          .onRef('community_members.community_id', '=', 'communities.id')
          .on('community_members.user_id', '=', userId),
      )
      .select([
        'community_spaces.conversation_id',
        'community_spaces.name',
        'community_spaces.auto_approve',
        'communities.id as community_id',
        'communities.name as community_name',
      ])
      .where('communities.deleted_at', 'is', null)
      .execute();
    const status = await this.#groups.spaceStatus(
      userId,
      rows.map((row) => row.conversation_id),
    );
    return {
      spaces: rows
        .filter((row) => status.joined.has(row.conversation_id))
        .map((row) => ({
          conversationId: row.conversation_id,
          communityId: row.community_id,
          communityName: row.community_name,
          name: row.name,
          autoApprove: row.auto_approve,
        })),
    };
  }
}
