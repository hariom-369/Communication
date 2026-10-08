import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Broadcast channels (docs/channels.md, ADR-012, ADR-046). Channels are NOT end-to-end
 * encrypted: everything here is readable by the server so that posts can reach any number of
 * subscribers, be searched and be moderated.
 */

/** Admin permission bits (docs/channels.md §3). The owner has all of them. */
export const CHANNEL_PERMISSIONS = {
  post: 1,
  editAny: 2,
  deleteAny: 4,
  manageComments: 8,
  viewAnalytics: 16,
  manageAdmins: 32,
  editChannelInfo: 64,
} as const;
export type ChannelPermission = keyof typeof CHANNEL_PERMISSIONS;
export const ALL_CHANNEL_PERMISSIONS = 127;

/** Reactions are a fixed set (no arbitrary text in counters). */
export const CHANNEL_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '🙏'] as const;
export const MAX_POST_LENGTH = 4096;
export const MAX_COMMENT_LENGTH = 2000;
export const MAX_POLL_OPTIONS = 10;
/** How long an ownership transfer waits before it takes effect. */
export const OWNERSHIP_COOLDOWN_HOURS = 24;

const plainText = (min: number, max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/(?![\n\r\t])\p{Cc}|[‪-‮⁦-⁩]/u.test(value), {
      message: 'Remove control or direction-override characters',
    })
    .transform((value) => value.replace(/\r\n?/g, '\n').trim())
    .refine((value) => value.length >= min, { message: `At least ${min} characters` });

export const channelHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/, { message: '3–32 letters, digits or underscores' });

export const channelVisibilitySchema = z.enum(['public', 'private']);

export const createChannelSchema = z.strictObject({
  handle: channelHandleSchema,
  title: plainText(1, 80),
  description: plainText(0, 1000),
  visibility: channelVisibilitySchema,
  commentsEnabled: z.boolean(),
  slowModeSeconds: z.number().int().min(0).max(3600),
});
export const updateChannelSchema = createChannelSchema.omit({ handle: true }).partial().strict();

export const channelParamsSchema = z.strictObject({ id: idSchema });
export const channelHandleParamsSchema = z.strictObject({ handle: channelHandleSchema });
export const channelMemberParamsSchema = z.strictObject({ id: idSchema, userId: idSchema });
export const channelPostParamsSchema = z.strictObject({ id: idSchema, postId: idSchema });
export const channelCommentParamsSchema = z.strictObject({ id: idSchema, commentId: idSchema });
export const channelLinkParamsSchema = z.strictObject({ id: idSchema, linkId: idSchema });

export const channelSummarySchema = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  description: z.string(),
  visibility: channelVisibilitySchema,
  subscriberCount: z.number().int(),
  lastPostAt: z.iso.datetime().nullable(),
});
export const channelListSchema = z.object({ channels: z.array(channelSummarySchema) });
export const channelDirectoryQuerySchema = z.strictObject({
  q: z.string().trim().max(60).default(''),
});

export const channelSchema = channelSummarySchema.extend({
  commentsEnabled: z.boolean(),
  slowModeSeconds: z.number().int(),
  createdAt: z.iso.datetime(),
  me: z.object({
    subscribed: z.boolean(),
    owner: z.boolean(),
    permissions: z.number().int(),
  }),
  /** Visible to the owner only. */
  pendingTransfer: z
    .object({ toUserId: z.string(), toUsername: z.string(), effectiveAt: z.iso.datetime() })
    .nullable(),
});

export const linkPreviewSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
});
export const linkPreviewRequestSchema = z.strictObject({ url: z.string().max(2048) });

export const createPollSchema = z.strictObject({
  question: plainText(1, 300),
  options: z.array(plainText(1, 100)).min(2).max(MAX_POLL_OPTIONS),
  multiple: z.boolean(),
  anonymous: z.boolean(),
});

export const createPostSchema = z
  .strictObject({
    body: plainText(0, MAX_POST_LENGTH),
    /** A link to preview; the server fetches it itself (ADR-046). */
    previewUrl: z.string().max(2048).nullable(),
    poll: createPollSchema.nullable(),
    /** Publish now (`now`), keep as a draft (`draft`), or schedule (an ISO time in the future). */
    publish: z.union([z.literal('now'), z.literal('draft'), z.iso.datetime()]),
  })
  .refine((post) => post.body.length > 0 || post.poll !== null, {
    message: 'Write something or add a poll',
    path: ['body'],
  });

export const updatePostSchema = z.strictObject({
  body: plainText(1, MAX_POST_LENGTH),
});

export const postStatusSchema = z.enum(['draft', 'scheduled', 'published', 'removed']);

export const channelPostSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  authorUsername: z.string(),
  status: postStatusSchema,
  body: z.string(),
  preview: linkPreviewSchema.nullable(),
  poll: z
    .object({
      question: z.string(),
      options: z.array(z.string()),
      multiple: z.boolean(),
      anonymous: z.boolean(),
      counts: z.array(z.number().int()),
      voters: z.number().int(),
      myChoices: z.array(z.number().int()),
    })
    .nullable(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number().int() })),
  myReaction: z.string().nullable(),
  commentCount: z.number().int(),
  publishAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  editedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const postListQuerySchema = z.strictObject({
  /** Opaque cursor from `nextCursor`. */
  before: z.string().max(200).optional(),
  status: z.enum(['published', 'draft', 'scheduled']).default('published'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const postListSchema = z.object({
  posts: z.array(channelPostSchema),
  nextCursor: z.string().nullable(),
});

export const postSearchQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(100) });

export const reactionSchema = z.strictObject({ emoji: z.enum(CHANNEL_REACTIONS).nullable() });
export const voteSchema = z.strictObject({
  choices: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_POLL_OPTIONS - 1),
    )
    .max(MAX_POLL_OPTIONS),
});
export const pollVotersSchema = z.object({
  options: z.array(z.object({ option: z.number().int(), usernames: z.array(z.string()) })),
});

export const createCommentSchema = z.strictObject({ body: plainText(1, MAX_COMMENT_LENGTH) });
export const commentQuerySchema = z.strictObject({ after: z.string().max(200).optional() });
export const commentSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  authorUsername: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export const commentListSchema = z.object({
  comments: z.array(commentSchema),
  nextCursor: z.string().nullable(),
});

export const recordViewsSchema = z.strictObject({ postIds: z.array(idSchema).min(1).max(50) });

export const channelAnalyticsSchema = z.object({
  subscriberCount: z.number().int(),
  days: z.array(
    z.object({
      day: z.string(),
      joined: z.number().int(),
      left: z.number().int(),
      views: z.number().int(),
    }),
  ),
  posts: z.array(
    z.object({
      id: z.string(),
      excerpt: z.string(),
      publishedAt: z.iso.datetime(),
      views: z.number().int(),
      reactions: z.number().int(),
      comments: z.number().int(),
    }),
  ),
});

export const channelAdminListSchema = z.object({
  admins: z.array(
    z.object({ userId: z.string(), username: z.string(), permissions: z.number().int() }),
  ),
});
export const setChannelAdminSchema = z.strictObject({
  permissions: z.number().int().min(1).max(ALL_CHANNEL_PERMISSIONS),
});
export const addChannelAdminSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(32),
  permissions: z.number().int().min(1).max(ALL_CHANNEL_PERMISSIONS),
});
export const transferChannelSchema = z.strictObject({ userId: idSchema });

export const createChannelLinkSchema = z.strictObject({
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(30 * 24),
  maxUses: z.number().int().min(1).max(1_000_000).nullable(),
});
export const channelLinkSchema = z.object({
  id: z.string(),
  expiresAt: z.iso.datetime(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  createdAt: z.iso.datetime(),
});
export const createdChannelLinkSchema = channelLinkSchema.extend({ token: z.string() });
export const channelLinkListSchema = z.object({ links: z.array(channelLinkSchema) });
export const channelInviteParamsSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{22}$/, { message: 'Invalid invite link' }),
});
export const channelInvitePreviewSchema = channelSummarySchema.extend({
  subscribed: z.boolean(),
});
