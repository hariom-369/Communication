import { z } from 'zod';

import { usernameSchema } from './accounts.js';
import { idSchema } from './common.js';
import { ciphersuiteSchema } from './messaging.js';

/**
 * End-to-end encrypted groups (docs/groups.md, ADR-044). The server never learns group names,
 * descriptions, pins or polls: they are encrypted messages. It stores membership, roles and
 * settings to enforce its API; clients enforce the MLS-authenticated copy.
 */

/** Members per E2EE group (crypto-core `MAX_GROUP_USERS`; join cost measured in ADR-044). */
export const MAX_GROUP_MEMBERS = 256;

const usernames = z
  .array(usernameSchema)
  .min(1)
  .max(MAX_GROUP_MEMBERS - 1);

export const createGroupSchema = z.strictObject({
  ciphersuite: ciphersuiteSchema,
  usernames: z.array(usernameSchema).max(MAX_GROUP_MEMBERS - 1),
});

export const addMembersSchema = z.strictObject({ usernames });

/** Who was added directly, who got an invitation instead (privacy settings), who could not be. */
export const addMembersResultSchema = z.object({
  added: z.array(z.object({ userId: z.string(), username: z.string() })),
  invited: z.array(z.object({ userId: z.string(), username: z.string() })),
  skipped: z.array(
    z.object({
      username: z.string(),
      reason: z.enum(['not_found', 'banned', 'member', 'full', 'not_allowed']),
    }),
  ),
});

export const createGroupResponseSchema = addMembersResultSchema.extend({
  conversationId: z.string(),
});

export const groupParamsSchema = z.strictObject({ id: idSchema });
export const groupMemberParamsSchema = z.strictObject({ id: idSchema, userId: idSchema });

export const setRoleSchema = z.strictObject({ role: z.enum(['admin', 'member']) });
export const transferOwnershipSchema = z.strictObject({ userId: idSchema });

export const groupSettingsSchema = z.strictObject({
  membersCanAdd: z.boolean(),
  announcementsOnly: z.boolean(),
});
export type GroupSettings = z.infer<typeof groupSettingsSchema>;

export const createInviteLinkSchema = z.strictObject({
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(30 * 24),
  maxUses: z.number().int().min(1).max(10_000).nullable(),
  /** Optional: shown before joining, readable by the server (the real name is E2EE). */
  previewTitle: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[\p{L}\p{N}\p{Zs}.,!?'()&+-]+$/u, { message: 'Use letters, numbers and punctuation' })
    .nullable(),
});

export const inviteLinkSchema = z.object({
  id: z.string(),
  expiresAt: z.iso.datetime(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  previewTitle: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
/** Only returned once, when the link is created. */
export const createdInviteLinkSchema = inviteLinkSchema.extend({ token: z.string() });
export const inviteLinkListSchema = z.object({ links: z.array(inviteLinkSchema) });
export const inviteLinkParamsSchema = z.strictObject({ id: idSchema, linkId: idSchema });

/** 128-bit token, base64url. */
export const inviteTokenParamsSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{22}$/, { message: 'Invalid invite link' }),
});
export const invitePreviewSchema = z.object({
  previewTitle: z.string().nullable(),
  memberCount: z.number().int(),
  alreadyMember: z.boolean(),
  requested: z.boolean(),
});

export const joinRequestListSchema = z.object({
  requests: z.array(
    z.object({ userId: z.string(), username: z.string(), createdAt: z.iso.datetime() }),
  ),
});

export const invitationListSchema = z.object({
  invitations: z.array(
    z.object({
      conversationId: z.string(),
      invitedBy: z.string(),
      memberCount: z.number().int(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

export const banListSchema = z.object({
  bans: z.array(
    z.object({ userId: z.string(), username: z.string(), createdAt: z.iso.datetime() }),
  ),
});
