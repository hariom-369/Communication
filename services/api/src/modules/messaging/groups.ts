import { createHash, randomBytes } from 'node:crypto';

import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  MAX_GROUP_MEMBERS,
  type PrivacySettings,
  type addMembersResultSchema,
  type banListSchema,
  type createdInviteLinkSchema,
  type invitationListSchema,
  type inviteLinkListSchema,
  type invitePreviewSchema,
  type joinRequestListSchema,
} from '@tessera/validation';
import type { Kysely, Transaction } from 'kysely';
import type { z } from 'zod';

import type { Database } from '../../db/schema.js';
import type { RealtimePublisher } from '../../platform/realtime-publisher.js';

/**
 * Groups (docs/groups.md, ADR-044): membership, roles, settings, invitations, invite links,
 * join requests and bans. This is the server's half of enforcement: it decides who may change
 * *membership on the server*; every client separately checks every MLS commit against the
 * end-to-end group policy, and only adds people an authorised member asked for in an encrypted
 * message — so a server that lies here can deny service, not read or join.
 */

export interface GroupDirectory {
  discoverableByUsername(username: string): Promise<{ id: string; username: string } | null>;
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
  privacySettings(userId: string): Promise<PrivacySettings>;
}

export interface GroupContacts {
  areContacts(a: string, b: string): Promise<boolean>;
}

/**
 * Communities (ADR-045) restrict who may be in their spaces. `mayJoin` returns null for groups
 * that are not community spaces.
 */
export interface SpaceGate {
  mayJoin(groupId: string, userId: string): Promise<boolean | null>;
}

type Role = 'owner' | 'admin' | 'member';
type Executor = Kysely<Database> | Transaction<Database>;
type AddResult = z.infer<typeof addMembersResultSchema>;

const DAY_MS = 24 * 60 * 60_000;
const INVITATION_TTL_MS = 30 * DAY_MS;

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export class GroupsService {
  readonly #db: Kysely<Database>;
  readonly #directory: GroupDirectory;
  readonly #contacts: GroupContacts;
  readonly #publisher: RealtimePublisher;
  readonly #logger: Logger;
  #spaces: SpaceGate | null = null;

  constructor(
    db: Kysely<Database>,
    directory: GroupDirectory,
    contacts: GroupContacts,
    publisher: RealtimePublisher,
    logger: Logger,
  ) {
    this.#db = db;
    this.#directory = directory;
    this.#contacts = contacts;
    this.#publisher = publisher;
    this.#logger = logger;
  }

  useSpaces(gate: SpaceGate): void {
    this.#spaces = gate;
  }

  // ---- helpers ---------------------------------------------------------------------------------

  /** Whether a user may be in this group (false only for community spaces they are not eligible for). */
  async #eligible(groupId: string, userId: string): Promise<boolean> {
    return (await this.#spaces?.mayJoin(groupId, userId)) !== false;
  }

  async #requireEligible(groupId: string, userId: string): Promise<void> {
    if (!(await this.#eligible(groupId, userId)))
      throw new AppError('FORBIDDEN', {
        detail: 'Only eligible members of this community can join this space.',
      });
  }

  /** The caller's membership of a (live) group; 404 for non-members, as for missing groups. */
  async #membership(executor: Executor, userId: string, groupId: string, lock = false) {
    let query = executor
      .selectFrom('conversations')
      .innerJoin('conversation_members', 'conversation_members.conversation_id', 'conversations.id')
      .select([
        'conversation_members.role',
        'conversations.members_can_add',
        'conversations.announcements_only',
        'conversations.last_seq',
      ])
      .where('conversations.id', '=', groupId)
      .where('conversations.kind', '=', 'group')
      .where('conversations.deleted_at', 'is', null)
      .where('conversation_members.user_id', '=', userId)
      .where('conversation_members.left_at', 'is', null);
    if (lock) query = query.forUpdate('conversations');
    const row = await query.executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  #requireAdmin(role: Role): void {
    if (role === 'member')
      throw new AppError('FORBIDDEN', { detail: 'Only group admins can do this.' });
  }

  async #memberIds(executor: Executor, groupId: string): Promise<string[]> {
    const rows = await executor
      .selectFrom('conversation_members')
      .select('user_id')
      .where('conversation_id', '=', groupId)
      .where('left_at', 'is', null)
      .execute();
    return rows.map((row) => row.user_id);
  }

  async #activeRole(executor: Executor, groupId: string, userId: string): Promise<Role | null> {
    const row = await executor
      .selectFrom('conversation_members')
      .select('role')
      .where('conversation_id', '=', groupId)
      .where('user_id', '=', userId)
      .where('left_at', 'is', null)
      .executeTakeFirst();
    return row?.role ?? null;
  }

  async #isBanned(executor: Executor, groupId: string, userId: string): Promise<boolean> {
    const row = await executor
      .selectFrom('group_bans')
      .select('user_id')
      .where('conversation_id', '=', groupId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Adds (or re-adds) a member. New members start at the current sequence number. */
  async #insertMember(
    trx: Transaction<Database>,
    groupId: string,
    userId: string,
    role: Role,
    addedBy: string,
  ): Promise<void> {
    const conversation = await trx
      .selectFrom('conversations')
      .select('last_seq')
      .where('id', '=', groupId)
      .executeTakeFirstOrThrow();
    const lastSeq = Number(conversation.last_seq);
    await trx
      .insertInto('conversation_members')
      .values({
        conversation_id: groupId,
        user_id: userId,
        role,
        acked_seq: lastSeq,
        added_by: addedBy,
      })
      .onConflict((oc) =>
        oc.columns(['conversation_id', 'user_id']).doUpdateSet({
          role,
          acked_seq: lastSeq,
          joined_at: new Date(),
          left_at: null,
          added_by: addedBy,
        }),
      )
      .execute();
    await trx
      .deleteFrom('group_invitations')
      .where('conversation_id', '=', groupId)
      .where('user_id', '=', userId)
      .execute();
    await trx
      .deleteFrom('group_join_requests')
      .where('conversation_id', '=', groupId)
      .where('user_id', '=', userId)
      .execute();
  }

  async #ensureRoom(executor: Executor, groupId: string, adding: number): Promise<void> {
    const count = (await this.#memberIds(executor, groupId)).length;
    if (count + adding > MAX_GROUP_MEMBERS)
      throw new AppError('CONFLICT', {
        detail: `Groups can have up to ${MAX_GROUP_MEMBERS} members.`,
      });
  }

  /** "Who can add me to groups" (privacy settings): direct add, or an invitation instead. */
  async #mayAddDirectly(adder: string, target: string): Promise<boolean> {
    const settings = await this.#directory.privacySettings(target);
    if (settings.groupInvites === 'everyone') return true;
    if (settings.groupInvites === 'nobody') return false;
    return this.#contacts.areContacts(adder, target);
  }

  #notify(userIds: readonly string[], groupId: string): void {
    if (userIds.length > 0)
      this.#publisher.publish([...new Set(userIds)], {
        type: 'conversation',
        conversationId: groupId,
      });
  }

  async #addPeople(
    trx: Transaction<Database>,
    actor: string,
    groupId: string,
    usernames: readonly string[],
  ): Promise<AddResult> {
    const result: AddResult = { added: [], invited: [], skipped: [] };
    const current = new Set(await this.#memberIds(trx, groupId));
    for (const username of [...new Set(usernames)]) {
      const user = await this.#directory.discoverableByUsername(username);
      if (user === null || user.id === actor) {
        result.skipped.push({ username, reason: 'not_found' });
        continue;
      }
      if (current.has(user.id)) {
        result.skipped.push({ username, reason: 'member' });
        continue;
      }
      if (await this.#isBanned(trx, groupId, user.id)) {
        result.skipped.push({ username, reason: 'banned' });
        continue;
      }
      if (!(await this.#eligible(groupId, user.id))) {
        result.skipped.push({ username, reason: 'not_allowed' });
        continue;
      }
      if (current.size + result.added.length >= MAX_GROUP_MEMBERS) {
        result.skipped.push({ username, reason: 'full' });
        continue;
      }
      if (await this.#mayAddDirectly(actor, user.id)) {
        await this.#insertMember(trx, groupId, user.id, 'member', actor);
        result.added.push({ userId: user.id, username: user.username });
      } else {
        await trx
          .insertInto('group_invitations')
          .values({
            conversation_id: groupId,
            user_id: user.id,
            invited_by: actor,
            expires_at: new Date(Date.now() + INVITATION_TTL_MS),
          })
          .onConflict((oc) =>
            oc.columns(['conversation_id', 'user_id']).doUpdateSet({
              invited_by: actor,
              expires_at: new Date(Date.now() + INVITATION_TTL_MS),
            }),
          )
          .execute();
        result.invited.push({ userId: user.id, username: user.username });
      }
    }
    return result;
  }

  // ---- creation and membership -----------------------------------------------------------------

  async create(
    actor: string,
    ciphersuite: number,
    usernames: readonly string[],
  ): Promise<{ groupId: string; result: AddResult }> {
    const groupId = newId();
    const result = await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('conversations')
        .values({ id: groupId, kind: 'group', ciphersuite, created_by: actor })
        .execute();
      await this.#insertMember(trx, groupId, actor, 'owner', actor);
      return this.#addPeople(trx, actor, groupId, usernames);
    });
    this.#notify(
      [...result.added, ...result.invited].map((u) => u.userId),
      groupId,
    );
    return { groupId, result };
  }

  async addMembers(
    actor: string,
    groupId: string,
    usernames: readonly string[],
  ): Promise<AddResult> {
    const result = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      if (me.role === 'member' && !me.members_can_add)
        throw new AppError('FORBIDDEN', { detail: 'Only group admins can add people.' });
      return this.#addPeople(trx, actor, groupId, usernames);
    });
    const members = await this.#memberIds(this.#db, groupId);
    this.#notify([...members, ...result.invited.map((u) => u.userId)], groupId);
    return result;
  }

  /** Removes someone (optionally banning them). Admins remove members; only the owner removes admins. */
  async remove(actor: string, groupId: string, target: string, ban: boolean): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      this.#requireAdmin(me.role);
      if (target === actor)
        throw new AppError('BAD_REQUEST', { detail: 'Leave the group instead.' });
      const role = await this.#activeRole(trx, groupId, target);
      if (role === null && !ban) throw new AppError('NOT_FOUND');
      if (role === 'owner')
        throw new AppError('FORBIDDEN', { detail: 'The owner cannot be removed.' });
      if (role === 'admin' && me.role !== 'owner')
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can remove admins.' });
      const members = await this.#memberIds(trx, groupId);
      await trx
        .updateTable('conversation_members')
        .set({ left_at: new Date() })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', target)
        .where('left_at', 'is', null)
        .execute();
      for (const table of ['group_invitations', 'group_join_requests'] as const)
        await trx
          .deleteFrom(table)
          .where('conversation_id', '=', groupId)
          .where('user_id', '=', target)
          .execute();
      if (ban)
        await trx
          .insertInto('group_bans')
          .values({ conversation_id: groupId, user_id: target, banned_by: actor })
          .onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doNothing())
          .execute();
      return members;
    });
    this.#notify(notified, groupId);
  }

  async leave(actor: string, groupId: string): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      const members = await this.#memberIds(trx, groupId);
      if (me.role === 'owner') {
        if (members.length > 1)
          throw new AppError('CONFLICT', {
            detail: 'Make another member the owner before you leave.',
          });
        await trx
          .updateTable('conversations')
          .set({ deleted_at: new Date() })
          .where('id', '=', groupId)
          .execute();
      }
      await trx
        .updateTable('conversation_members')
        .set({ left_at: new Date() })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', actor)
        .execute();
      return members;
    });
    this.#notify(notified, groupId);
  }

  async setRole(
    actor: string,
    groupId: string,
    target: string,
    role: 'admin' | 'member',
  ): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      if (me.role !== 'owner')
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can change roles.' });
      const current = await this.#activeRole(trx, groupId, target);
      if (current === null) throw new AppError('NOT_FOUND');
      if (current === 'owner')
        throw new AppError('BAD_REQUEST', { detail: 'Transfer ownership instead.' });
      await trx
        .updateTable('conversation_members')
        .set({ role })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', target)
        .execute();
      return this.#memberIds(trx, groupId);
    });
    this.#notify(notified, groupId);
  }

  /** The owner hands the group to an admin (and becomes an admin). */
  async transferOwnership(actor: string, groupId: string, target: string): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      if (me.role !== 'owner')
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can do this.' });
      if ((await this.#activeRole(trx, groupId, target)) !== 'admin')
        throw new AppError('BAD_REQUEST', { detail: 'Make them an admin first.' });
      await trx
        .updateTable('conversation_members')
        .set({ role: 'admin' })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', actor)
        .execute();
      await trx
        .updateTable('conversation_members')
        .set({ role: 'owner' })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', target)
        .execute();
      return this.#memberIds(trx, groupId);
    });
    this.#notify(notified, groupId);
  }

  async updateSettings(
    actor: string,
    groupId: string,
    settings: { membersCanAdd: boolean; announcementsOnly: boolean },
  ): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      this.#requireAdmin(me.role);
      await trx
        .updateTable('conversations')
        .set({
          members_can_add: settings.membersCanAdd,
          announcements_only: settings.announcementsOnly,
        })
        .where('id', '=', groupId)
        .execute();
      return this.#memberIds(trx, groupId);
    });
    this.#notify(notified, groupId);
  }

  async deleteGroup(actor: string, groupId: string): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      if (me.role !== 'owner')
        throw new AppError('FORBIDDEN', { detail: 'Only the owner can delete the group.' });
      const members = await this.#memberIds(trx, groupId);
      const now = new Date();
      await trx
        .updateTable('conversations')
        .set({ deleted_at: now })
        .where('id', '=', groupId)
        .execute();
      await trx
        .updateTable('conversation_members')
        .set({ left_at: now })
        .where('conversation_id', '=', groupId)
        .where('left_at', 'is', null)
        .execute();
      await trx
        .updateTable('group_links')
        .set({ revoked_at: now })
        .where('conversation_id', '=', groupId)
        .execute();
      return members;
    });
    this.#notify(notified, groupId);
  }

  // ---- invitations (privacy-limited adds) -------------------------------------------------------

  async invitations(userId: string): Promise<z.infer<typeof invitationListSchema>> {
    const rows = await this.#db
      .selectFrom('group_invitations')
      .innerJoin('conversations', 'conversations.id', 'group_invitations.conversation_id')
      .select([
        'group_invitations.conversation_id',
        'group_invitations.invited_by',
        'group_invitations.created_at',
      ])
      .where('group_invitations.user_id', '=', userId)
      .where('group_invitations.expires_at', '>', new Date())
      .where('conversations.deleted_at', 'is', null)
      .orderBy('group_invitations.created_at', 'desc')
      .limit(100)
      .execute();
    const names = await this.#directory.usernames(rows.map((row) => row.invited_by));
    const invitations = [];
    for (const row of rows)
      invitations.push({
        conversationId: row.conversation_id,
        invitedBy: names.get(row.invited_by) ?? 'deleted',
        memberCount: (await this.#memberIds(this.#db, row.conversation_id)).length,
        createdAt: row.created_at.toISOString(),
      });
    return { invitations };
  }

  async respondToInvitation(userId: string, groupId: string, accept: boolean): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const invitation = await trx
        .selectFrom('group_invitations')
        .select('invited_by')
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', userId)
        .where('expires_at', '>', new Date())
        .forUpdate()
        .executeTakeFirst();
      if (invitation === undefined) throw new AppError('NOT_FOUND');
      await trx
        .deleteFrom('group_invitations')
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', userId)
        .execute();
      if (!accept) return [];
      const live = await trx
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', groupId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (live === undefined || (await this.#isBanned(trx, groupId, userId)))
        throw new AppError('NOT_FOUND');
      await this.#requireEligible(groupId, userId);
      await this.#ensureRoom(trx, groupId, 1);
      await this.#insertMember(trx, groupId, userId, 'member', invitation.invited_by);
      return this.#memberIds(trx, groupId);
    });
    this.#notify(notified, groupId);
  }

  // ---- invite links and join requests ---------------------------------------------------------

  async createLink(
    actor: string,
    groupId: string,
    input: { expiresInHours: number; maxUses: number | null; previewTitle: string | null },
  ): Promise<z.infer<typeof createdInviteLinkSchema>> {
    const me = await this.#membership(this.#db, actor, groupId);
    if (me.role === 'member' && !me.members_can_add)
      throw new AppError('FORBIDDEN', { detail: 'Only group admins can create invite links.' });
    const token = randomBytes(16).toString('base64url');
    const id = newId();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + input.expiresInHours * 3_600_000);
    await this.#db
      .insertInto('group_links')
      .values({
        id,
        conversation_id: groupId,
        token_digest: digest(token),
        created_by: actor,
        created_at: createdAt,
        expires_at: expiresAt,
        max_uses: input.maxUses,
        preview_title: input.previewTitle,
      })
      .execute();
    return {
      id,
      token,
      expiresAt: expiresAt.toISOString(),
      maxUses: input.maxUses,
      uses: 0,
      previewTitle: input.previewTitle,
      createdAt: createdAt.toISOString(),
    };
  }

  async links(actor: string, groupId: string): Promise<z.infer<typeof inviteLinkListSchema>> {
    const me = await this.#membership(this.#db, actor, groupId);
    this.#requireAdmin(me.role);
    const rows = await this.#db
      .selectFrom('group_links')
      .selectAll()
      .where('conversation_id', '=', groupId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .execute();
    return {
      links: rows
        .filter((row) => row.max_uses === null || row.uses < row.max_uses)
        .map((row) => ({
          id: row.id,
          expiresAt: row.expires_at.toISOString(),
          maxUses: row.max_uses,
          uses: row.uses,
          previewTitle: row.preview_title,
          createdAt: row.created_at.toISOString(),
        })),
    };
  }

  async revokeLink(actor: string, groupId: string, linkId: string): Promise<void> {
    const me = await this.#membership(this.#db, actor, groupId);
    const link = await this.#db
      .selectFrom('group_links')
      .select('created_by')
      .where('id', '=', linkId)
      .where('conversation_id', '=', groupId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (link === undefined) throw new AppError('NOT_FOUND');
    if (me.role === 'member' && link.created_by !== actor)
      throw new AppError('FORBIDDEN', { detail: 'Only group admins can revoke this link.' });
    await this.#db
      .updateTable('group_links')
      .set({ revoked_at: new Date() })
      .where('id', '=', linkId)
      .execute();
  }

  async #liveLink(executor: Executor, token: string, lock = false) {
    let query = executor
      .selectFrom('group_links')
      .innerJoin('conversations', 'conversations.id', 'group_links.conversation_id')
      .select([
        'group_links.id',
        'group_links.conversation_id',
        'group_links.max_uses',
        'group_links.uses',
        'group_links.preview_title',
      ])
      .where('group_links.token_digest', '=', digest(token))
      .where('group_links.revoked_at', 'is', null)
      .where('group_links.expires_at', '>', new Date())
      .where('conversations.deleted_at', 'is', null);
    if (lock) query = query.forUpdate('group_links');
    const link = await query.executeTakeFirst();
    // Expired, revoked, used up and unknown links look the same.
    if (link === undefined || (link.max_uses !== null && link.uses >= link.max_uses))
      throw new AppError('NOT_FOUND', { detail: 'This invite link is not valid.' });
    return link;
  }

  async previewLink(userId: string, token: string): Promise<z.infer<typeof invitePreviewSchema>> {
    const link = await this.#liveLink(this.#db, token);
    const members = await this.#memberIds(this.#db, link.conversation_id);
    const request = await this.#db
      .selectFrom('group_join_requests')
      .select('user_id')
      .where('conversation_id', '=', link.conversation_id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return {
      previewTitle: link.preview_title,
      memberCount: members.length,
      alreadyMember: members.includes(userId),
      requested: request !== undefined,
    };
  }

  /** Asks to join through a link; an admin approves (and their device adds the person). */
  async requestJoin(userId: string, token: string): Promise<{ groupId: string | null }> {
    const result = await this.#db.transaction().execute(async (trx) => {
      const link = await this.#liveLink(trx, token, true);
      const groupId = link.conversation_id;
      if ((await this.#activeRole(trx, groupId, userId)) !== null)
        return { groupId, notify: [] as string[], requestGroup: groupId };
      if (await this.#isBanned(trx, groupId, userId))
        throw new AppError('FORBIDDEN', { detail: 'You cannot join this group.' });
      await this.#requireEligible(groupId, userId);
      const inserted = await trx
        .insertInto('group_join_requests')
        .values({ conversation_id: groupId, user_id: userId, link_id: link.id })
        .onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doNothing())
        .returning('user_id')
        .executeTakeFirst();
      if (inserted !== undefined)
        await trx
          .updateTable('group_links')
          .set({ uses: link.uses + 1 })
          .where('id', '=', link.id)
          .execute();
      const admins = await trx
        .selectFrom('conversation_members')
        .select('user_id')
        .where('conversation_id', '=', groupId)
        .where('left_at', 'is', null)
        .where('role', 'in', ['owner', 'admin'])
        .execute();
      return { groupId: null, notify: admins.map((row) => row.user_id), requestGroup: groupId };
    });
    if (result.notify.length > 0)
      this.#publisher.publish(result.notify, {
        type: 'group_requests',
        conversationId: result.requestGroup,
      });
    return { groupId: result.groupId };
  }

  async joinRequests(
    actor: string,
    groupId: string,
  ): Promise<z.infer<typeof joinRequestListSchema>> {
    const me = await this.#membership(this.#db, actor, groupId);
    this.#requireAdmin(me.role);
    const rows = await this.#db
      .selectFrom('group_join_requests')
      .select(['user_id', 'created_at'])
      .where('conversation_id', '=', groupId)
      .orderBy('created_at', 'asc')
      .limit(200)
      .execute();
    const names = await this.#directory.usernames(rows.map((row) => row.user_id));
    return {
      requests: rows.map((row) => ({
        userId: row.user_id,
        username: names.get(row.user_id) ?? 'deleted',
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async resolveJoinRequest(
    actor: string,
    groupId: string,
    target: string,
    approve: boolean,
  ): Promise<void> {
    const notified = await this.#db.transaction().execute(async (trx) => {
      const me = await this.#membership(trx, actor, groupId, true);
      this.#requireAdmin(me.role);
      const request = await trx
        .deleteFrom('group_join_requests')
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', target)
        .executeTakeFirst();
      if (Number(request.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      if (!approve) return [];
      await this.#requireEligible(groupId, target);
      await this.#ensureRoom(trx, groupId, 1);
      await this.#insertMember(trx, groupId, target, 'member', actor);
      return this.#memberIds(trx, groupId);
    });
    this.#notify(notified, groupId);
  }

  // ---- bans ------------------------------------------------------------------------------------

  async bans(actor: string, groupId: string): Promise<z.infer<typeof banListSchema>> {
    const me = await this.#membership(this.#db, actor, groupId);
    this.#requireAdmin(me.role);
    const rows = await this.#db
      .selectFrom('group_bans')
      .select(['user_id', 'created_at'])
      .where('conversation_id', '=', groupId)
      .orderBy('created_at', 'desc')
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

  async unban(actor: string, groupId: string, target: string): Promise<void> {
    const me = await this.#membership(this.#db, actor, groupId);
    this.#requireAdmin(me.role);
    const deleted = await this.#db
      .deleteFrom('group_bans')
      .where('conversation_id', '=', groupId)
      .where('user_id', '=', target)
      .executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
    this.#logger.info('groups.unban', { ok: true });
  }

  // ---- community spaces (used by the communities module; ADR-045) -------------------------------

  /** A new group for a community space, owned by its creator (who then names it end to end). */
  async createSpace(actor: string, ciphersuite: number): Promise<string> {
    const groupId = newId();
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('conversations')
        .values({ id: groupId, kind: 'group', ciphersuite, created_by: actor })
        .execute();
      await this.#insertMember(trx, groupId, actor, 'owner', actor);
    });
    this.#notify([actor], groupId);
    return groupId;
  }

  /**
   * An eligible community member asks to join a space; the space's admins (in practice an admin
   * device, automatically for auto-approve spaces) add them end to end.
   */
  async requestSpaceJoin(userId: string, groupId: string): Promise<'member' | 'requested'> {
    const result = await this.#db.transaction().execute(async (trx) => {
      if ((await this.#activeRole(trx, groupId, userId)) !== null)
        return { status: 'member' as const, notify: [] as string[] };
      if (await this.#isBanned(trx, groupId, userId))
        throw new AppError('FORBIDDEN', { detail: 'You cannot join this space.' });
      await this.#requireEligible(groupId, userId);
      await trx
        .insertInto('group_join_requests')
        .values({ conversation_id: groupId, user_id: userId, link_id: null })
        .onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doNothing())
        .execute();
      const admins = await trx
        .selectFrom('conversation_members')
        .select('user_id')
        .where('conversation_id', '=', groupId)
        .where('left_at', 'is', null)
        .where('role', 'in', ['owner', 'admin'])
        .execute();
      return { status: 'requested' as const, notify: admins.map((row) => row.user_id) };
    });
    if (result.notify.length > 0)
      this.#publisher.publish(result.notify, { type: 'group_requests', conversationId: groupId });
    return result.status;
  }

  /** Which of these groups the user is in, or has asked to join. */
  async spaceStatus(
    userId: string,
    groupIds: readonly string[],
  ): Promise<{ joined: Set<string>; requested: Set<string> }> {
    if (groupIds.length === 0) return { joined: new Set(), requested: new Set() };
    const [members, requests] = await Promise.all([
      this.#db
        .selectFrom('conversation_members')
        .select('conversation_id')
        .where('user_id', '=', userId)
        .where('left_at', 'is', null)
        .where('conversation_id', 'in', [...groupIds])
        .execute(),
      this.#db
        .selectFrom('group_join_requests')
        .select('conversation_id')
        .where('user_id', '=', userId)
        .where('conversation_id', 'in', [...groupIds])
        .execute(),
    ]);
    return {
      joined: new Set(members.map((row) => row.conversation_id)),
      requested: new Set(requests.map((row) => row.conversation_id)),
    };
  }

  /**
   * Takes users out of groups on the community's behalf (left, kicked, banned, lost a role).
   * Members' devices then remove them from the encryption group (they are no longer listed).
   * A space owner who loses eligibility is removed too; server-side ownership passes to the
   * longest-standing admin, whose device then takes over end to end (the group policy lets an
   * admin become owner once the owner is gone). With no admin the space has no owner.
   */
  async removeFromGroups(userIds: readonly string[], groupIds: readonly string[]): Promise<void> {
    if (userIds.length === 0 || groupIds.length === 0) return;
    const notified = await this.#db.transaction().execute(async (trx) => {
      const affected = new Map<string, string[]>();
      for (const groupId of groupIds) {
        const members = await this.#memberIds(trx, groupId);
        const leaving = userIds.filter((userId) => members.includes(userId));
        await trx
          .deleteFrom('group_join_requests')
          .where('conversation_id', '=', groupId)
          .where('user_id', 'in', [...userIds])
          .execute();
        if (leaving.length === 0) continue;
        const removed = await trx
          .updateTable('conversation_members')
          .set({ left_at: new Date() })
          .where('conversation_id', '=', groupId)
          .where('user_id', 'in', leaving)
          .where('left_at', 'is', null)
          .returning('role')
          .execute();
        if (removed.some((row) => row.role === 'owner')) await this.#promoteSuccessor(trx, groupId);
        affected.set(groupId, members);
      }
      return affected;
    });
    for (const [groupId, members] of notified) this.#notify(members, groupId);
  }

  async #promoteSuccessor(trx: Transaction<Database>, groupId: string): Promise<void> {
    const next = await trx
      .selectFrom('conversation_members')
      .select('user_id')
      .where('conversation_id', '=', groupId)
      .where('left_at', 'is', null)
      .where('role', '=', 'admin')
      .orderBy('joined_at')
      .limit(1)
      .executeTakeFirst();
    if (next !== undefined)
      await trx
        .updateTable('conversation_members')
        .set({ role: 'owner' })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', next.user_id)
        .execute();
  }

  /** Deletes groups on the community's behalf (space or community deleted). */
  async deleteGroups(groupIds: readonly string[]): Promise<void> {
    if (groupIds.length === 0) return;
    const notified = await this.#db.transaction().execute(async (trx) => {
      const affected = new Map<string, string[]>();
      const now = new Date();
      for (const groupId of groupIds) {
        affected.set(groupId, await this.#memberIds(trx, groupId));
        await trx
          .updateTable('conversations')
          .set({ deleted_at: now })
          .where('id', '=', groupId)
          .where('deleted_at', 'is', null)
          .execute();
        await trx
          .updateTable('conversation_members')
          .set({ left_at: now })
          .where('conversation_id', '=', groupId)
          .where('left_at', 'is', null)
          .execute();
        await trx
          .updateTable('group_links')
          .set({ revoked_at: now })
          .where('conversation_id', '=', groupId)
          .execute();
      }
      return affected;
    });
    for (const [groupId, members] of notified) this.#notify(members, groupId);
  }
}
