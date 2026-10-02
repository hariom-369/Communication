import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Communities (docs/groups.md §5, ADR-045). A community is a server-known container — its name,
 * description, rules, roles and members are readable by the server — holding spaces, which are
 * end-to-end encrypted groups.
 */

/** Permission bits of a community role. The owner has all of them. */
export const COMMUNITY_PERMISSIONS = {
  manageCommunity: 1,
  manageRoles: 2,
  manageSpaces: 4,
  kickMembers: 8,
  banMembers: 16,
  createInvites: 32,
} as const;
export type CommunityPermission = keyof typeof COMMUNITY_PERMISSIONS;
export const ALL_COMMUNITY_PERMISSIONS = 63;
export const MAX_COMMUNITY_ROLES = 50;
export const MAX_COMMUNITY_SPACES = 100;
export const MAX_COMMUNITY_MEMBERS = 100_000;

const displayText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, { message: 'Remove control characters' });
/** Multi-line text: no control characters except new lines and tabs, no direction overrides. */
const longText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/(?![\n\r\t])\p{Cc}|[\u202A-\u202E\u2066-\u2069]/u.test(value), {
      message: 'Remove control or direction-override characters',
    })
    .transform((value) => value.replace(/\r\n?/g, '\n').trim());

export const communityVisibilitySchema = z.enum(['public', 'private']);

export const createCommunitySchema = z.strictObject({
  name: displayText(3, 60),
  description: longText(500),
  visibility: communityVisibilitySchema,
  rules: longText(4000),
  minAccountAgeDays: z.number().int().min(0).max(365),
});

export const updateCommunitySchema = createCommunitySchema.partial().strict();

export const communityParamsSchema = z.strictObject({ id: idSchema });
export const communityMemberParamsSchema = z.strictObject({ id: idSchema, userId: idSchema });
export const communityRoleParamsSchema = z.strictObject({ id: idSchema, roleId: idSchema });
export const communitySpaceParamsSchema = z.strictObject({ id: idSchema, spaceId: idSchema });
export const communityLinkParamsSchema = z.strictObject({ id: idSchema, linkId: idSchema });

export const communitySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: communityVisibilitySchema,
  memberCount: z.number().int(),
});
export const communityListSchema = z.object({ communities: z.array(communitySummarySchema) });

export const directoryQuerySchema = z.strictObject({
  q: z.string().trim().max(60).default(''),
});

export const communityRoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  permissions: z.number().int(),
});

export const communitySchema = communitySummarySchema.extend({
  rules: z.string(),
  rulesVersion: z.number().int(),
  minAccountAgeDays: z.number().int(),
  ownerId: z.string(),
  createdAt: z.iso.datetime(),
  roles: z.array(communityRoleSchema),
  /** The caller's standing. */
  me: z.object({
    member: z.boolean(),
    owner: z.boolean(),
    banned: z.boolean(),
    permissions: z.number().int(),
    roleIds: z.array(z.string()),
    /** Highest role position (owner: above every role). */
    rank: z.number().int(),
  }),
});

/** Joining requires accepting the current rules version (sent back as proof of what was shown). */
export const joinCommunitySchema = z.strictObject({ rulesVersion: z.number().int().min(1) });

export const createCommunityRoleSchema = z.strictObject({
  name: displayText(1, 32),
  permissions: z.number().int().min(0).max(ALL_COMMUNITY_PERMISSIONS),
  position: z.number().int().min(1).max(1000),
});
export const updateCommunityRoleSchema = createCommunityRoleSchema.partial().strict();

export const communityMemberListQuerySchema = z.strictObject({
  cursor: idSchema.optional(),
});
export const communityMemberListSchema = z.object({
  members: z.array(
    z.object({
      userId: z.string(),
      username: z.string(),
      roleIds: z.array(z.string()),
      owner: z.boolean(),
      joinedAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const setMemberRolesSchema = z.strictObject({
  roleIds: z.array(idSchema).max(20),
});

export const communityBanSchema = z.strictObject({ userId: idSchema });
export const communityBanListSchema = z.object({
  bans: z.array(
    z.object({ userId: z.string(), username: z.string(), createdAt: z.iso.datetime() }),
  ),
});

export const transferCommunitySchema = z.strictObject({ userId: idSchema });

export const createCommunityLinkSchema = z.strictObject({
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(30 * 24),
  maxUses: z.number().int().min(1).max(100_000).nullable(),
});
export const communityLinkSchema = z.object({
  id: z.string(),
  expiresAt: z.iso.datetime(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  createdAt: z.iso.datetime(),
});
export const createdCommunityLinkSchema = communityLinkSchema.extend({ token: z.string() });
export const communityLinkListSchema = z.object({ links: z.array(communityLinkSchema) });
export const communityInviteParamsSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{22}$/, { message: 'Invalid invite link' }),
});
export const communityInvitePreviewSchema = communitySummarySchema.extend({
  rules: z.string(),
  rulesVersion: z.number().int(),
  minAccountAgeDays: z.number().int(),
  alreadyMember: z.boolean(),
});

export const createSpaceSchema = z.strictObject({
  name: displayText(1, 60),
  /** Empty: every member may join. Otherwise only members holding one of these roles. */
  roleIds: z.array(idSchema).max(10),
  autoApprove: z.boolean(),
  ciphersuite: z.number().int(),
});
export const spaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  roleIds: z.array(z.string()),
  autoApprove: z.boolean(),
  joined: z.boolean(),
  requested: z.boolean(),
});
export const spaceListSchema = z.object({ spaces: z.array(spaceSchema) });
export const joinSpaceResponseSchema = z.object({ status: z.enum(['member', 'requested']) });

/** Spaces the caller belongs to, across communities (to label conversations). */
export const mySpacesSchema = z.object({
  spaces: z.array(
    z.object({
      conversationId: z.string(),
      communityId: z.string(),
      communityName: z.string(),
      name: z.string(),
      autoApprove: z.boolean(),
    }),
  ),
});
