import {
  addMembersResultSchema,
  addMembersSchema,
  banListSchema,
  createGroupResponseSchema,
  createGroupSchema,
  createInviteLinkSchema,
  createdInviteLinkSchema,
  groupMemberParamsSchema,
  groupParamsSchema,
  groupSettingsSchema,
  invitationListSchema,
  inviteLinkListSchema,
  inviteLinkParamsSchema,
  invitePreviewSchema,
  inviteTokenParamsSchema,
  joinRequestListSchema,
  okResponseSchema,
  setRoleSchema,
  transferOwnershipSchema,
} from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { GroupsService } from './groups.js';

export interface GroupsModuleDeps {
  readonly groups: GroupsService;
}

const limits = {
  create: {
    name: 'groups.create',
    limit: 30,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  manage: {
    name: 'groups.manage',
    limit: 300,
    periodMs: 3_600_000,
    burst: 60,
    onStoreFailure: 'closed',
  },
  join: {
    name: 'groups.join',
    limit: 30,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  read: { name: 'groups.read', limit: 300, periodMs: 60_000, burst: 60, onStoreFailure: 'open' },
} satisfies Record<string, RateLimitPolicy>;

const membership = {
  kind: 'none',
  reason: 'Group membership changes are visible to members and mirrored in the encrypted group',
} as const;
const readOnly = { kind: 'none', reason: 'Read-only' } as const;
const ok = { ok: true as const };
const banBody = z.strictObject({ userId: z.uuid() });
const emptyBody = z.strictObject({});

export function groupRoutes(deps: GroupsModuleDeps): RouteDefinition[] {
  const { groups } = deps;
  return [
    defineRoute({
      id: 'groups.create',
      method: 'POST',
      url: '/api/v1/groups',
      summary: 'Create an end-to-end encrypted group (its name is set in an encrypted message)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.create,
      audit: membership,
      schema: { body: createGroupSchema, response: createGroupResponseSchema },
      successStatus: 201,
      handler: async ({ body }, context) => {
        const { groupId, result } = await groups.create(
          context.session.userId,
          body.ciphersuite,
          body.usernames,
        );
        return { conversationId: groupId, ...result };
      },
    }),
    defineRoute({
      id: 'groups.add_members',
      method: 'POST',
      url: '/api/v1/groups/:id/members',
      summary: 'Add people (or invite those whose privacy settings require it)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: {
        params: groupParamsSchema,
        body: addMembersSchema,
        response: addMembersResultSchema,
      },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        groups.addMembers(context.session.userId, params.id, body.usernames),
    }),
    defineRoute({
      id: 'groups.remove_member',
      method: 'DELETE',
      url: '/api/v1/groups/:id/members/:userId',
      summary: 'Remove a member',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupMemberParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.remove(context.session.userId, params.id, params.userId, false);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.leave',
      method: 'POST',
      url: '/api/v1/groups/:id/leave',
      summary: 'Leave a group (the owner hands it over first, unless they are the last member)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: {
        body: emptyBody,
        params: groupParamsSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.leave(context.session.userId, params.id);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.set_role',
      method: 'PUT',
      url: '/api/v1/groups/:id/members/:userId/role',
      summary: 'Make a member an admin, or not (owner only; mirrors the encrypted group policy)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupMemberParamsSchema, body: setRoleSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await groups.setRole(context.session.userId, params.id, params.userId, body.role);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.transfer_ownership',
      method: 'POST',
      url: '/api/v1/groups/:id/owner',
      summary: 'Hand the group to an admin',
      tags: ['groups'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: {
        params: groupParamsSchema,
        body: transferOwnershipSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await groups.transferOwnership(context.session.userId, params.id, body.userId);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.update_settings',
      method: 'PUT',
      url: '/api/v1/groups/:id/settings',
      summary: 'Who can add people, announcements-only (admins; mirrors the encrypted policy)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupParamsSchema, body: groupSettingsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await groups.updateSettings(context.session.userId, params.id, body);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.delete',
      method: 'DELETE',
      url: '/api/v1/groups/:id',
      summary: 'Delete the group for everyone (owner)',
      tags: ['groups'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.deleteGroup(context.session.userId, params.id);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.invitations',
      method: 'GET',
      url: '/api/v1/group-invitations',
      summary: 'Groups the caller was invited to',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: invitationListSchema },
      successStatus: 200,
      handler: (_input, context) => groups.invitations(context.session.userId),
    }),
    defineRoute({
      id: 'groups.accept_invitation',
      method: 'POST',
      url: '/api/v1/group-invitations/:id/accept',
      summary: 'Accept an invitation to a group',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.join,
      audit: membership,
      schema: {
        body: emptyBody,
        params: groupParamsSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.respondToInvitation(context.session.userId, params.id, true);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.decline_invitation',
      method: 'DELETE',
      url: '/api/v1/group-invitations/:id',
      summary: 'Decline an invitation to a group',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.join,
      audit: membership,
      schema: { params: groupParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.respondToInvitation(context.session.userId, params.id, false);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.create_link',
      method: 'POST',
      url: '/api/v1/groups/:id/links',
      summary: 'Create an invite link (joining asks an admin)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: {
        params: groupParamsSchema,
        body: createInviteLinkSchema,
        response: createdInviteLinkSchema,
      },
      successStatus: 201,
      handler: ({ params, body }, context) =>
        groups.createLink(context.session.userId, params.id, body),
    }),
    defineRoute({
      id: 'groups.links',
      method: 'GET',
      url: '/api/v1/groups/:id/links',
      summary: 'Active invite links (admins)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: groupParamsSchema, response: inviteLinkListSchema },
      successStatus: 200,
      handler: ({ params }, context) => groups.links(context.session.userId, params.id),
    }),
    defineRoute({
      id: 'groups.revoke_link',
      method: 'DELETE',
      url: '/api/v1/groups/:id/links/:linkId',
      summary: 'Revoke an invite link',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: inviteLinkParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.revokeLink(context.session.userId, params.id, params.linkId);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.preview_link',
      method: 'GET',
      url: '/api/v1/invites/:token',
      summary: 'What an invite link leads to (the optional preview title and member count only)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.join,
      audit: readOnly,
      schema: { params: inviteTokenParamsSchema, response: invitePreviewSchema },
      successStatus: 200,
      handler: ({ params }, context) => groups.previewLink(context.session.userId, params.token),
    }),
    defineRoute({
      id: 'groups.request_join',
      method: 'POST',
      url: '/api/v1/invites/:token/join',
      summary: 'Ask to join through an invite link',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.join,
      audit: membership,
      schema: {
        body: emptyBody,
        params: inviteTokenParamsSchema,
        response: z.object({ groupId: z.string().nullable() }),
      },
      successStatus: 200,
      handler: ({ params }, context) => groups.requestJoin(context.session.userId, params.token),
    }),
    defineRoute({
      id: 'groups.join_requests',
      method: 'GET',
      url: '/api/v1/groups/:id/requests',
      summary: 'Pending join requests (admins)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: groupParamsSchema, response: joinRequestListSchema },
      successStatus: 200,
      handler: ({ params }, context) => groups.joinRequests(context.session.userId, params.id),
    }),
    defineRoute({
      id: 'groups.approve_request',
      method: 'POST',
      url: '/api/v1/groups/:id/requests/:userId/approve',
      summary: 'Approve a join request',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: {
        body: emptyBody,
        params: groupMemberParamsSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.resolveJoinRequest(context.session.userId, params.id, params.userId, true);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.reject_request',
      method: 'DELETE',
      url: '/api/v1/groups/:id/requests/:userId',
      summary: 'Reject a join request',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupMemberParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.resolveJoinRequest(context.session.userId, params.id, params.userId, false);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.ban',
      method: 'POST',
      url: '/api/v1/groups/:id/bans',
      summary: 'Remove someone and stop them rejoining through links',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupParamsSchema, body: banBody, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await groups.remove(context.session.userId, params.id, body.userId, true);
        return ok;
      },
    }),
    defineRoute({
      id: 'groups.bans',
      method: 'GET',
      url: '/api/v1/groups/:id/bans',
      summary: 'Banned people (admins)',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: groupParamsSchema, response: banListSchema },
      successStatus: 200,
      handler: ({ params }, context) => groups.bans(context.session.userId, params.id),
    }),
    defineRoute({
      id: 'groups.unban',
      method: 'DELETE',
      url: '/api/v1/groups/:id/bans/:userId',
      summary: 'Lift a ban',
      tags: ['groups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: groupMemberParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await groups.unban(context.session.userId, params.id, params.userId);
        return ok;
      },
    }),
  ];
}
