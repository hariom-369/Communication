import {
  communityBanListSchema,
  communityBanSchema,
  communityInviteParamsSchema,
  communityInvitePreviewSchema,
  communityLinkListSchema,
  communityLinkParamsSchema,
  communityListSchema,
  communityMemberListQuerySchema,
  communityMemberListSchema,
  communityMemberParamsSchema,
  communityParamsSchema,
  communityRoleParamsSchema,
  communitySchema,
  communitySpaceParamsSchema,
  createCommunityLinkSchema,
  createCommunityRoleSchema,
  createCommunitySchema,
  createSpaceSchema,
  createdCommunityLinkSchema,
  directoryQuerySchema,
  joinCommunitySchema,
  joinSpaceResponseSchema,
  mySpacesSchema,
  okResponseSchema,
  setMemberRolesSchema,
  spaceListSchema,
  transferCommunitySchema,
  updateCommunityRoleSchema,
  updateCommunitySchema,
} from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { CommunitiesService } from './communities.js';

export interface CommunitiesModuleDeps {
  readonly communities: CommunitiesService;
}

const limits = {
  create: {
    name: 'communities.create',
    limit: 10,
    periodMs: 3_600_000,
    burst: 5,
    onStoreFailure: 'closed',
  },
  manage: {
    name: 'communities.manage',
    limit: 600,
    periodMs: 3_600_000,
    burst: 60,
    onStoreFailure: 'closed',
  },
  join: {
    name: 'communities.join',
    limit: 60,
    periodMs: 3_600_000,
    burst: 20,
    onStoreFailure: 'closed',
  },
  read: {
    name: 'communities.read',
    limit: 300,
    periodMs: 60_000,
    burst: 60,
    onStoreFailure: 'open',
  },
} satisfies Record<string, RateLimitPolicy>;

const readOnly = { kind: 'none', reason: 'Read-only' } as const;
const membership = {
  kind: 'none',
  reason: 'Self-service membership; visible to community moderators',
} as const;
const ok = { ok: true as const };
const emptyBody = z.strictObject({});
const idResponse = z.object({ id: z.string() });
const common = { tags: ['communities'], auth: { kind: 'session' }, authorize: ownAccount } as const;

export function communityRoutes(deps: CommunitiesModuleDeps): RouteDefinition[] {
  const { communities } = deps;
  return [
    defineRoute({
      ...common,
      id: 'communities.create',
      method: 'POST',
      url: '/api/v1/communities',
      summary: 'Create a community (its name, rules and roles are readable by the server)',
      rateLimit: limits.create,
      audit: { kind: 'records', actions: ['communities.created'] },
      schema: { body: createCommunitySchema, response: idResponse },
      successStatus: 201,
      handler: async ({ body }, context) => ({
        id: await communities.create(context.session.userId, body, context.requestId),
      }),
    }),
    defineRoute({
      ...common,
      id: 'communities.mine',
      method: 'GET',
      url: '/api/v1/communities',
      summary: 'Communities the caller belongs to',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: communityListSchema },
      successStatus: 200,
      handler: (_input, context) => communities.mine(context.session.userId),
    }),
    defineRoute({
      ...common,
      id: 'communities.discover',
      method: 'GET',
      url: '/api/v1/community-directory',
      summary: 'Search public communities by name',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { querystring: directoryQuerySchema, response: communityListSchema },
      successStatus: 200,
      handler: ({ query }) => communities.discover(query.q),
    }),
    defineRoute({
      ...common,
      id: 'communities.get',
      method: 'GET',
      url: '/api/v1/communities/:id',
      summary: 'A community, its roles and the caller’s standing',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: communityParamsSchema, response: communitySchema },
      successStatus: 200,
      handler: ({ params }, context) => communities.get(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,
      id: 'communities.update',
      method: 'PATCH',
      url: '/api/v1/communities/:id',
      summary: 'Change the name, description, visibility, rules or verification gate',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.updated'] },
      schema: {
        params: communityParamsSchema,
        body: updateCommunitySchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await communities.update(context.session.userId, params.id, body, context.requestId);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.delete',
      method: 'DELETE',
      url: '/api/v1/communities/:id',
      summary: 'Delete the community and all its spaces (owner)',
      auth: { kind: 'session', stepUp: true },
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.deleted'] },
      schema: { params: communityParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.delete(context.session.userId, params.id, context.requestId);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.join',
      method: 'POST',
      url: '/api/v1/communities/:id/join',
      summary: 'Join a public community (accepting its current rules)',
      rateLimit: limits.join,
      audit: membership,
      schema: {
        params: communityParamsSchema,
        body: joinCommunitySchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await communities.join(context.session.userId, params.id, body.rulesVersion);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.leave',
      method: 'POST',
      url: '/api/v1/communities/:id/leave',
      summary: 'Leave a community (and all its spaces)',
      rateLimit: limits.join,
      audit: membership,
      schema: { params: communityParamsSchema, body: emptyBody, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.leave(context.session.userId, params.id);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.members',
      method: 'GET',
      url: '/api/v1/communities/:id/members',
      summary: 'Members and their roles (members only)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: {
        params: communityParamsSchema,
        querystring: communityMemberListQuerySchema,
        response: communityMemberListSchema,
      },
      successStatus: 200,
      handler: ({ params, query }, context) =>
        communities.members(context.session.userId, params.id, query.cursor),
    }),
    defineRoute({
      ...common,
      id: 'communities.transfer',
      method: 'POST',
      url: '/api/v1/communities/:id/owner',
      summary: 'Hand the community to another member',
      auth: { kind: 'session', stepUp: true },
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.ownership_transferred'] },
      schema: {
        params: communityParamsSchema,
        body: transferCommunitySchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await communities.transfer(
          context.session.userId,
          params.id,
          body.userId,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.create_role',
      method: 'POST',
      url: '/api/v1/communities/:id/roles',
      summary: 'Create a role below your own',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.roles_changed'] },
      schema: {
        params: communityParamsSchema,
        body: createCommunityRoleSchema,
        response: idResponse,
      },
      successStatus: 201,
      handler: async ({ params, body }, context) => ({
        id: await communities.createRole(
          context.session.userId,
          params.id,
          body,
          context.requestId,
        ),
      }),
    }),
    defineRoute({
      ...common,
      id: 'communities.update_role',
      method: 'PATCH',
      url: '/api/v1/communities/:id/roles/:roleId',
      summary: 'Change a role below your own',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.roles_changed'] },
      schema: {
        params: communityRoleParamsSchema,
        body: updateCommunityRoleSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await communities.updateRole(
          context.session.userId,
          params.id,
          params.roleId,
          body,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.delete_role',
      method: 'DELETE',
      url: '/api/v1/communities/:id/roles/:roleId',
      summary: 'Delete a role below your own',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.roles_changed'] },
      schema: { params: communityRoleParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.deleteRole(
          context.session.userId,
          params.id,
          params.roleId,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.set_member_roles',
      method: 'PUT',
      url: '/api/v1/communities/:id/members/:userId/roles',
      summary: 'Set a member’s roles (only roles below your own)',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.roles_changed'] },
      schema: {
        params: communityMemberParamsSchema,
        body: setMemberRolesSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await communities.setMemberRoles(
          context.session.userId,
          params.id,
          params.userId,
          body.roleIds,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.kick',
      method: 'DELETE',
      url: '/api/v1/communities/:id/members/:userId',
      summary: 'Remove a member (and from every space)',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.member_kicked'] },
      schema: { params: communityMemberParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.remove(
          context.session.userId,
          params.id,
          params.userId,
          false,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.ban',
      method: 'POST',
      url: '/api/v1/communities/:id/bans',
      summary: 'Ban someone (removing them from the community and its spaces)',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.member_banned'] },
      schema: {
        params: communityParamsSchema,
        body: communityBanSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await communities.remove(
          context.session.userId,
          params.id,
          body.userId,
          true,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.bans',
      method: 'GET',
      url: '/api/v1/communities/:id/bans',
      summary: 'Banned users',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: communityParamsSchema, response: communityBanListSchema },
      successStatus: 200,
      handler: ({ params }, context) => communities.bans(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,
      id: 'communities.unban',
      method: 'DELETE',
      url: '/api/v1/communities/:id/bans/:userId',
      summary: 'Lift a ban',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['communities.member_unbanned'] },
      schema: { params: communityMemberParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.unban(
          context.session.userId,
          params.id,
          params.userId,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.create_link',
      method: 'POST',
      url: '/api/v1/communities/:id/links',
      summary: 'Create an invite link (shown once)',
      rateLimit: limits.manage,
      audit: membership,
      schema: {
        params: communityParamsSchema,
        body: createCommunityLinkSchema,
        response: createdCommunityLinkSchema,
      },
      successStatus: 201,
      handler: ({ params, body }, context) =>
        communities.createLink(context.session.userId, params.id, body),
    }),
    defineRoute({
      ...common,
      id: 'communities.links',
      method: 'GET',
      url: '/api/v1/communities/:id/links',
      summary: 'Active invite links',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: communityParamsSchema, response: communityLinkListSchema },
      successStatus: 200,
      handler: ({ params }, context) => communities.links(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,
      id: 'communities.revoke_link',
      method: 'DELETE',
      url: '/api/v1/communities/:id/links/:linkId',
      summary: 'Revoke an invite link',
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: communityLinkParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.revokeLink(context.session.userId, params.id, params.linkId);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.preview_link',
      method: 'GET',
      url: '/api/v1/community-invites/:token',
      summary: 'What an invite link leads to',
      rateLimit: limits.join,
      audit: readOnly,
      schema: { params: communityInviteParamsSchema, response: communityInvitePreviewSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        communities.previewLink(context.session.userId, params.token),
    }),
    defineRoute({
      ...common,
      id: 'communities.join_link',
      method: 'POST',
      url: '/api/v1/community-invites/:token/join',
      summary: 'Join through an invite link (accepting the current rules)',
      rateLimit: limits.join,
      audit: membership,
      schema: {
        params: communityInviteParamsSchema,
        body: joinCommunitySchema,
        response: idResponse,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => ({
        id: await communities.joinViaLink(context.session.userId, params.token, body.rulesVersion),
      }),
    }),
    defineRoute({
      ...common,
      id: 'communities.create_space',
      method: 'POST',
      url: '/api/v1/communities/:id/spaces',
      summary: 'Create an end-to-end encrypted space (you own its group)',
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: communityParamsSchema, body: createSpaceSchema, response: idResponse },
      successStatus: 201,
      handler: async ({ params, body }, context) => ({
        id: await communities.createSpace(context.session.userId, params.id, body),
      }),
    }),
    defineRoute({
      ...common,
      id: 'communities.spaces',
      method: 'GET',
      url: '/api/v1/communities/:id/spaces',
      summary: 'Spaces the caller may see and join',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: communityParamsSchema, response: spaceListSchema },
      successStatus: 200,
      handler: ({ params }, context) => communities.spaces(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,
      id: 'communities.delete_space',
      method: 'DELETE',
      url: '/api/v1/communities/:id/spaces/:spaceId',
      summary: 'Delete a space for everyone',
      rateLimit: limits.manage,
      audit: membership,
      schema: { params: communitySpaceParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await communities.deleteSpace(context.session.userId, params.id, params.spaceId);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'communities.join_space',
      method: 'POST',
      url: '/api/v1/communities/:id/spaces/:spaceId/join',
      summary: 'Ask to join a space (a space admin’s device adds you)',
      rateLimit: limits.join,
      audit: membership,
      schema: {
        params: communitySpaceParamsSchema,
        body: emptyBody,
        response: joinSpaceResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params }, context) => ({
        status: await communities.joinSpace(context.session.userId, params.id, params.spaceId),
      }),
    }),
    defineRoute({
      ...common,
      id: 'communities.my_spaces',
      method: 'GET',
      url: '/api/v1/community-spaces',
      summary: 'Spaces the caller is in, with their community (to label conversations)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: mySpacesSchema },
      successStatus: 200,
      handler: (_input, context) => communities.mySpaces(context.session.userId),
    }),
  ];
}
