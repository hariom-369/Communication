import {
  channelNotificationsSchema,
  addChannelAdminSchema,
  channelAdminListSchema,
  channelAnalyticsSchema,
  channelCommentParamsSchema,
  channelDirectoryQuerySchema,
  channelHandleParamsSchema,
  channelInviteParamsSchema,
  channelInvitePreviewSchema,
  channelLinkListSchema,
  channelLinkParamsSchema,
  channelListSchema,
  channelMemberParamsSchema,
  channelParamsSchema,
  channelPostParamsSchema,
  channelPostSchema,
  channelSchema,
  commentListSchema,
  commentQuerySchema,
  commentSchema,
  createChannelLinkSchema,
  createChannelSchema,
  createCommentSchema,
  createPostSchema,
  createdChannelLinkSchema,
  linkPreviewRequestSchema,
  linkPreviewSchema,
  okResponseSchema,
  pollVotersSchema,
  postListQuerySchema,
  postListSchema,
  postSearchQuerySchema,
  reactionSchema,
  recordViewsSchema,
  setChannelAdminSchema,
  transferChannelSchema,
  updateChannelSchema,
  updatePostSchema,
  voteSchema,
} from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { ChannelsService } from './channels.js';
import type { LinkPreviewer } from './previews.js';

export interface ChannelsModuleDeps {
  readonly channels: ChannelsService;
  readonly previews: LinkPreviewer;
}

const policy = (
  name: string,
  limit: number,
  periodMs: number,
  burst: number,
  onStoreFailure: 'open' | 'closed',
): RateLimitPolicy => ({ name: `channels.${name}`, limit, periodMs, burst, onStoreFailure });

const limits = {
  create: policy('create', 10, 3_600_000, 5, 'closed'),
  manage: policy('manage', 300, 3_600_000, 60, 'closed'),
  subscribe: policy('subscribe', 120, 3_600_000, 30, 'closed'),
  post: policy('post', 120, 3_600_000, 30, 'closed'),
  interact: policy('interact', 600, 3_600_000, 60, 'closed'),
  comment: policy('comment', 120, 3_600_000, 20, 'closed'),
  // Each preview may cost an outbound fetch: kept low (ADR-046).
  preview: policy('preview', 30, 3_600_000, 10, 'closed'),
  search: policy('search', 60, 60_000, 20, 'open'),
  views: policy('views', 600, 60_000, 120, 'open'),
  read: policy('read', 600, 60_000, 120, 'open'),
} satisfies Record<string, RateLimitPolicy>;

const readOnly = { kind: 'none', reason: 'Read-only or idempotent counters' } as const;
const selfService = {
  kind: 'none',
  reason: 'Content and membership changes visible in the channel itself',
} as const;
const ok = { ok: true as const };
const emptyBody = z.strictObject({});
const idResponse = z.object({ id: z.string() });
const common = { tags: ['channels'], auth: { kind: 'session' }, authorize: ownAccount } as const;

export function channelRoutes(deps: ChannelsModuleDeps): RouteDefinition[] {
  const { channels, previews } = deps;
  return [
    defineRoute({
      ...common,

      id: 'channels.create',
      method: 'POST',
      url: '/api/v1/channels',
      summary: 'Create a channel (not end-to-end encrypted)',
      rateLimit: limits.create,
      audit: { kind: 'records', actions: ['channels.created'] },
      schema: { body: createChannelSchema, response: idResponse },
      successStatus: 201,
      handler: async ({ body }, context) => ({
        id: await channels.create(context.session.userId, body, context.requestId),
      }),
    }),
    defineRoute({
      ...common,

      id: 'channels.mine',
      method: 'GET',
      url: '/api/v1/channels',
      summary: 'Channels the caller subscribes to or administers',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: channelListSchema },
      successStatus: 200,
      handler: (_input, context) => channels.mine(context.session.userId),
    }),
    defineRoute({
      ...common,

      id: 'channels.discover',
      method: 'GET',
      url: '/api/v1/channel-directory',
      summary: 'Search public channels',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { querystring: channelDirectoryQuerySchema, response: channelListSchema },
      successStatus: 200,
      handler: ({ query }) => channels.discover(query.q),
    }),
    defineRoute({
      ...common,

      id: 'channels.by_handle',
      method: 'GET',
      url: '/api/v1/channel-handles/:handle',
      summary: 'Find a channel by handle',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: channelHandleParamsSchema, response: idResponse },
      successStatus: 200,
      handler: ({ params }, context) => channels.byHandle(context.session.userId, params.handle),
    }),
    defineRoute({
      ...common,

      id: 'channels.get',
      method: 'GET',
      url: '/api/v1/channels/:id',
      summary: 'A channel and the caller’s standing',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: channelParamsSchema, response: channelSchema },
      successStatus: 200,
      handler: ({ params }, context) => channels.get(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,

      id: 'channels.update',
      method: 'PATCH',
      url: '/api/v1/channels/:id',
      summary: 'Change channel info and comment settings',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.updated'] },
      schema: {
        params: channelParamsSchema,
        body: updateChannelSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await channels.update(context.session.userId, params.id, body, context.requestId);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      auth: { kind: 'session', stepUp: true },
      id: 'channels.delete',
      method: 'DELETE',
      url: '/api/v1/channels/:id',
      summary: 'Delete the channel (owner)',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.deleted'] },
      schema: { params: channelParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.delete(context.session.userId, params.id, context.requestId);
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.subscribe',
      method: 'POST',
      url: '/api/v1/channels/:id/subscription',
      summary: 'Subscribe to a public channel',
      rateLimit: limits.subscribe,
      audit: selfService,
      schema: { params: channelParamsSchema, body: emptyBody, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.subscribe(context.session.userId, params.id);
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.unsubscribe',
      method: 'DELETE',
      url: '/api/v1/channels/:id/subscription',
      summary: 'Unsubscribe',
      rateLimit: limits.subscribe,
      audit: selfService,
      schema: { params: channelParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.unsubscribe(context.session.userId, params.id);
        return ok;
      },
    }),
    defineRoute({
      ...common,
      id: 'channels.notifications',
      method: 'PUT',
      url: '/api/v1/channels/:id/notifications',
      summary: 'Turn push notifications for new posts on or off (subscribers)',
      rateLimit: limits.subscribe,
      audit: selfService,
      schema: {
        params: channelParamsSchema,
        body: channelNotificationsSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await channels.setNotifications(context.session.userId, params.id, body.enabled);
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.admins',
      method: 'GET',
      url: '/api/v1/channels/:id/admins',
      summary: 'Owner and admins with their permissions',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: channelParamsSchema, response: channelAdminListSchema },
      successStatus: 200,
      handler: ({ params }, context) => channels.admins(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,

      id: 'channels.add_admin',
      method: 'POST',
      url: '/api/v1/channels/:id/admins',
      summary: 'Make someone an admin',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.admins_changed'] },
      schema: {
        params: channelParamsSchema,
        body: addChannelAdminSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await channels.setAdmin(
          context.session.userId,
          params.id,
          { username: body.username },
          body.permissions,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.set_admin',
      method: 'PUT',
      url: '/api/v1/channels/:id/admins/:userId',
      summary: 'Change an admin’s permissions',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.admins_changed'] },
      schema: {
        params: channelMemberParamsSchema,
        body: setChannelAdminSchema,
        response: okResponseSchema,
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await channels.setAdmin(
          context.session.userId,
          params.id,
          { userId: params.userId },
          body.permissions,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.remove_admin',
      method: 'DELETE',
      url: '/api/v1/channels/:id/admins/:userId',
      summary: 'Remove an admin (or step down)',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.admins_changed'] },
      schema: { params: channelMemberParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.removeAdmin(
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
      auth: { kind: 'session', stepUp: true },
      id: 'channels.request_transfer',
      method: 'POST',
      url: '/api/v1/channels/:id/ownership',
      summary: 'Hand the channel to an admin after a cooling-off period',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.ownership_requested'] },
      schema: {
        params: channelParamsSchema,
        body: transferChannelSchema,
        response: z.object({ effectiveAt: z.string() }),
      },
      successStatus: 200,
      handler: async ({ params, body }, context) => ({
        effectiveAt: await channels.requestTransfer(
          context.session.userId,
          params.id,
          body.userId,
          context.requestId,
        ),
      }),
    }),
    defineRoute({
      ...common,

      id: 'channels.cancel_transfer',
      method: 'DELETE',
      url: '/api/v1/channels/:id/ownership',
      summary: 'Cancel a pending ownership transfer',
      rateLimit: limits.manage,
      audit: { kind: 'records', actions: ['channels.ownership_cancelled'] },
      schema: { params: channelParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.cancelTransfer(context.session.userId, params.id, context.requestId);
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.create_link',
      method: 'POST',
      url: '/api/v1/channels/:id/links',
      summary: 'Create an invite link (shown once)',
      rateLimit: limits.manage,
      audit: selfService,
      schema: {
        params: channelParamsSchema,
        body: createChannelLinkSchema,
        response: createdChannelLinkSchema,
      },
      successStatus: 201,
      handler: ({ params, body }, context) =>
        channels.createLink(context.session.userId, params.id, body),
    }),
    defineRoute({
      ...common,

      id: 'channels.links',
      method: 'GET',
      url: '/api/v1/channels/:id/links',
      summary: 'Active invite links',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: channelParamsSchema, response: channelLinkListSchema },
      successStatus: 200,
      handler: ({ params }, context) => channels.links(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,

      id: 'channels.revoke_link',
      method: 'DELETE',
      url: '/api/v1/channels/:id/links/:linkId',
      summary: 'Revoke an invite link',
      rateLimit: limits.manage,
      audit: selfService,
      schema: { params: channelLinkParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.revokeLink(context.session.userId, params.id, params.linkId);
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.preview_invite',
      method: 'GET',
      url: '/api/v1/channel-invites/:token',
      summary: 'What an invite link leads to',
      rateLimit: limits.subscribe,
      audit: readOnly,
      schema: { params: channelInviteParamsSchema, response: channelInvitePreviewSchema },
      successStatus: 200,
      handler: ({ params }, context) => channels.previewLink(context.session.userId, params.token),
    }),
    defineRoute({
      ...common,

      id: 'channels.join_invite',
      method: 'POST',
      url: '/api/v1/channel-invites/:token/subscription',
      summary: 'Subscribe through an invite link',
      rateLimit: limits.subscribe,
      audit: selfService,
      schema: { params: channelInviteParamsSchema, body: emptyBody, response: idResponse },
      successStatus: 200,
      handler: async ({ params }, context) => ({
        id: await channels.subscribeViaLink(context.session.userId, params.token),
      }),
    }),
    defineRoute({
      ...common,

      id: 'channels.posts',
      method: 'GET',
      url: '/api/v1/channels/:id/posts',
      summary: 'Feed (or drafts and scheduled posts, for admins)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: {
        params: channelParamsSchema,
        querystring: postListQuerySchema,
        response: postListSchema,
      },
      successStatus: 200,
      handler: ({ params, query }, context) =>
        channels.posts(context.session.userId, params.id, query),
    }),
    defineRoute({
      ...common,

      id: 'channels.search',
      method: 'GET',
      url: '/api/v1/channels/:id/search',
      summary: 'Search the channel’s posts',
      rateLimit: limits.search,
      audit: readOnly,
      schema: {
        params: channelParamsSchema,
        querystring: postSearchQuerySchema,
        response: postListSchema,
      },
      successStatus: 200,
      handler: ({ params, query }, context) =>
        channels.search(context.session.userId, params.id, query.q),
    }),
    defineRoute({
      ...common,

      id: 'channels.create_post',
      method: 'POST',
      url: '/api/v1/channels/:id/posts',
      summary: 'Publish, schedule or draft a post',
      rateLimit: limits.post,
      audit: selfService,
      schema: { params: channelParamsSchema, body: createPostSchema, response: channelPostSchema },
      successStatus: 201,
      handler: ({ params, body }, context) =>
        channels.createPost(context.session.userId, params.id, body),
    }),
    defineRoute({
      ...common,

      id: 'channels.update_post',
      method: 'PATCH',
      url: '/api/v1/channels/:id/posts/:postId',
      summary: 'Edit a post',
      rateLimit: limits.post,
      audit: selfService,
      schema: {
        params: channelPostParamsSchema,
        body: updatePostSchema,
        response: channelPostSchema,
      },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        channels.updatePost(context.session.userId, params.id, params.postId, body.body),
    }),
    defineRoute({
      ...common,

      id: 'channels.publish_post',
      method: 'POST',
      url: '/api/v1/channels/:id/posts/:postId/publish',
      summary: 'Publish a draft or scheduled post now',
      rateLimit: limits.post,
      audit: selfService,
      schema: { params: channelPostParamsSchema, body: emptyBody, response: channelPostSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        channels.publishNow(context.session.userId, params.id, params.postId),
    }),
    defineRoute({
      ...common,

      id: 'channels.delete_post',
      method: 'DELETE',
      url: '/api/v1/channels/:id/posts/:postId',
      summary: 'Remove a post',
      rateLimit: limits.post,
      audit: { kind: 'records', actions: ['channels.post_removed'] },
      schema: { params: channelPostParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.deletePost(
          context.session.userId,
          params.id,
          params.postId,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.react',
      method: 'PUT',
      url: '/api/v1/channels/:id/posts/:postId/reaction',
      summary: 'React to a post (one reaction each)',
      rateLimit: limits.interact,
      audit: selfService,
      schema: {
        params: channelPostParamsSchema,
        body: reactionSchema,
        response: channelPostSchema,
      },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        channels.react(context.session.userId, params.id, params.postId, body.emoji),
    }),
    defineRoute({
      ...common,

      id: 'channels.vote',
      method: 'PUT',
      url: '/api/v1/channels/:id/posts/:postId/vote',
      summary: 'Vote in a poll (an empty list retracts)',
      rateLimit: limits.interact,
      audit: selfService,
      schema: { params: channelPostParamsSchema, body: voteSchema, response: channelPostSchema },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        channels.vote(context.session.userId, params.id, params.postId, body.choices),
    }),
    defineRoute({
      ...common,

      id: 'channels.voters',
      method: 'GET',
      url: '/api/v1/channels/:id/posts/:postId/voters',
      summary: 'Who voted for what (public polls only)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: channelPostParamsSchema, response: pollVotersSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        channels.voters(context.session.userId, params.id, params.postId),
    }),
    defineRoute({
      ...common,

      id: 'channels.comments',
      method: 'GET',
      url: '/api/v1/channels/:id/posts/:postId/comments',
      summary: 'Comments on a post',
      rateLimit: limits.read,
      audit: readOnly,
      schema: {
        params: channelPostParamsSchema,
        querystring: commentQuerySchema,
        response: commentListSchema,
      },
      successStatus: 200,
      handler: ({ params, query }, context) =>
        channels.comments(context.session.userId, params.id, params.postId, query.after),
    }),
    defineRoute({
      ...common,

      id: 'channels.add_comment',
      method: 'POST',
      url: '/api/v1/channels/:id/posts/:postId/comments',
      summary: 'Comment on a post',
      rateLimit: limits.comment,
      audit: selfService,
      schema: {
        params: channelPostParamsSchema,
        body: createCommentSchema,
        response: commentSchema,
      },
      successStatus: 201,
      handler: ({ params, body }, context) =>
        channels.addComment(context.session.userId, params.id, params.postId, body.body),
    }),
    defineRoute({
      ...common,

      id: 'channels.delete_comment',
      method: 'DELETE',
      url: '/api/v1/channels/:id/comments/:commentId',
      summary: 'Delete a comment',
      rateLimit: limits.interact,
      audit: { kind: 'records', actions: ['channels.comment_removed'] },
      schema: { params: channelCommentParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await channels.deleteComment(
          context.session.userId,
          params.id,
          params.commentId,
          context.requestId,
        );
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.record_views',
      method: 'POST',
      url: '/api/v1/channels/:id/views',
      summary: 'Count the caller as a viewer of posts (unique per day)',
      rateLimit: limits.views,
      audit: readOnly,
      schema: { params: channelParamsSchema, body: recordViewsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await channels.recordViews(context.session.userId, params.id, body.postIds);
        return ok;
      },
    }),
    defineRoute({
      ...common,

      id: 'channels.analytics',
      method: 'GET',
      url: '/api/v1/channels/:id/analytics',
      summary: 'Aggregate analytics (no per-subscriber data)',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: channelParamsSchema, response: channelAnalyticsSchema },
      successStatus: 200,
      handler: ({ params }, context) => channels.analytics(context.session.userId, params.id),
    }),
    defineRoute({
      ...common,

      id: 'channels.link_preview',
      method: 'POST',
      url: '/api/v1/link-previews',
      summary: 'Preview a link (fetched by the SSRF-hardened fetcher)',
      rateLimit: limits.preview,
      audit: readOnly,
      schema: { body: linkPreviewRequestSchema, response: linkPreviewSchema.nullable() },
      successStatus: 200,
      handler: ({ body }) => previews.preview(body.url),
    }),
  ];
}
