import {
  conversationMutesSchema,
  notificationConfigSchema,
  notificationPreferencesSchema,
  securityAlertsSchema,
  type NotificationPreferences,
  activeCallSchema,
  callCapabilitiesSchema,
  callSchema,
  iceConfigSchema,
  joinedCallSchema,
  startedCallSchema,
  channelAdminListSchema,
  channelAnalyticsSchema,
  channelInvitePreviewSchema,
  channelLinkListSchema,
  channelListSchema,
  channelPostSchema,
  channelSchema,
  commentListSchema,
  commentSchema,
  createdChannelLinkSchema,
  linkPreviewSchema,
  pollVotersSchema,
  postListSchema,
  communityBanListSchema,
  communityInvitePreviewSchema,
  communityLinkListSchema,
  communityListSchema,
  communityMemberListSchema,
  communitySchema,
  createdCommunityLinkSchema,
  joinSpaceResponseSchema,
  mySpacesSchema,
  spaceListSchema,
  addMembersResultSchema,
  banListSchema,
  createGroupResponseSchema,
  createdInviteLinkSchema,
  invitationListSchema,
  inviteLinkListSchema,
  invitePreviewSchema,
  joinRequestListSchema,
  type GroupSettings,
  mediaDownloadSchema,
  uploadCreatedSchema,
  uploadPartsResponseSchema,
  backupDownloadSchema,
  backupStatusSchema,
  linkCreatedSchema,
  linkRequestSchema,
  linkStatusSchema,
  type AddBackupWrap,
  type AddDevice,
  type CreateLink,
  type UploadBackup,
  claimedKeyPackagesSchema,
  commitResponseSchema,
  keyPackageCountSchema,
  ownKeysSchema,
  userKeysSchema,
  welcomeListSchema,
  type RegisterDevice,
  conversationListSchema,
  conversationSchema,
  messageListSchema,
  presenceSchema,
  realtimeTicketSchema,
  sendMessageResponseSchema,
  syncResponseSchema,
  meResponseSchema,
  okResponseSchema,
  passkeyListSchema,
  passkeyOptionsResponseSchema,
  privacySettingsSchema,
  recoveryCodesResponseSchema,
  sessionListSchema,
  sessionStateSchema,
  signupResponseSchema,
  totpSetupResponseSchema,
  type PrivacySettings,
  type SignupRequest,
} from '@tessera/validation';
import { z } from 'zod';

import { api } from './client.js';

interface ChannelInput {
  title: string;
  description: string;
  visibility: 'public' | 'private';
  commentsEnabled: boolean;
  slowModeSeconds: number;
}

/** Typed API surface used by the web app; schemas are shared with the server. */
export const endpoints = {
  signup: (body: SignupRequest) => api('POST', '/accounts', signupResponseSchema, body),
  resendVerification: (email: string) =>
    api('POST', '/accounts/resend-verification', signupResponseSchema, { email }),
  verifyEmail: (email: string, code: string) =>
    api('POST', '/accounts/verify-email', sessionStateSchema, { email, code }),
  me: () => api('GET', '/accounts/me', meResponseSchema),
  privacy: () => api('GET', '/accounts/me/privacy', privacySettingsSchema),
  updatePrivacy: (settings: PrivacySettings) =>
    api('PUT', '/accounts/me/privacy', okResponseSchema, settings),

  login: (identifier: string, password: string) =>
    api('POST', '/auth/login', sessionStateSchema, { identifier, password }),
  loginMfa: (factor: { totpCode: string } | { recoveryCode: string }) =>
    api('POST', '/auth/login/mfa', sessionStateSchema, factor),
  logout: () => api('POST', '/auth/logout', okResponseSchema, {}),

  setInitialPassword: (password: string) =>
    api('POST', '/auth/password/initial', sessionStateSchema, { password }),
  changePassword: (password: string) =>
    api('PUT', '/auth/password', sessionStateSchema, { password }),
  reauthPassword: (body: { password: string; totpCode?: string; recoveryCode?: string }) =>
    api('POST', '/auth/reauth/password', sessionStateSchema, body),

  passkeyRegisterOptions: () =>
    api('POST', '/auth/passkeys/register/options', passkeyOptionsResponseSchema, {}),
  passkeyRegisterVerify: (flowId: string, name: string, response: Record<string, unknown>) =>
    api('POST', '/auth/passkeys/register/verify', sessionStateSchema, { flowId, name, response }),
  passkeyLoginOptions: (purpose: 'login' | 'reauth') =>
    api('POST', '/auth/passkeys/login/options', passkeyOptionsResponseSchema, { purpose }),
  passkeyLoginVerify: (flowId: string, response: Record<string, unknown>) =>
    api('POST', '/auth/passkeys/login/verify', sessionStateSchema, { flowId, response }),
  reauthPasskey: (flowId: string, response: Record<string, unknown>) =>
    api('POST', '/auth/reauth/passkey', sessionStateSchema, { flowId, response }),
  passkeys: () => api('GET', '/auth/passkeys', passkeyListSchema),
  deletePasskey: (id: string) =>
    api('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`, okResponseSchema),

  totpSetup: () => api('POST', '/auth/totp/setup', totpSetupResponseSchema, {}),
  totpConfirm: (code: string) =>
    api('POST', '/auth/totp/confirm', recoveryCodesResponseSchema, { code }),
  totpDisable: () => api('DELETE', '/auth/totp', okResponseSchema),
  regenerateRecoveryCodes: () =>
    api('POST', '/auth/recovery-codes', recoveryCodesResponseSchema, {}),

  requestPasswordReset: (email: string) =>
    api('POST', '/auth/password-reset', okResponseSchema, { email }),
  completePasswordReset: (body: {
    token: string;
    password: string;
    totpCode?: string;
    recoveryCode?: string;
  }) => api('POST', '/auth/password-reset/complete', okResponseSchema, body),

  sessions: () => api('GET', '/auth/sessions', sessionListSchema),
  revokeSession: (id: string) =>
    api('DELETE', `/auth/sessions/${encodeURIComponent(id)}`, okResponseSchema),
  revokeOtherSessions: () =>
    api('POST', '/auth/sessions/revoke-others', z.object({ revoked: z.number() }), {}),

  openDirect: (username: string, ciphersuite: number) =>
    api('POST', '/conversations/direct', conversationSchema, { username, ciphersuite }),
  conversations: (cursor?: string) =>
    api(
      'GET',
      `/conversations?limit=50${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      conversationListSchema,
    ),
  conversation: (id: string) =>
    api('GET', `/conversations/${encodeURIComponent(id)}`, conversationSchema),

  // ---- channels (docs/channels.md; not end-to-end encrypted) ----
  myChannels: () => api('GET', '/channels', channelListSchema),
  discoverChannels: (q: string) =>
    api('GET', `/channel-directory?q=${encodeURIComponent(q)}`, channelListSchema),
  channel: (id: string) => api('GET', `/channels/${encodeURIComponent(id)}`, channelSchema),
  channelByHandle: (handle: string) =>
    api('GET', `/channel-handles/${encodeURIComponent(handle)}`, z.object({ id: z.string() })),
  createChannel: (body: ChannelInput & { handle: string }) =>
    api('POST', '/channels', z.object({ id: z.string() }), body),
  updateChannel: (id: string, body: Partial<ChannelInput>) =>
    api('PATCH', `/channels/${encodeURIComponent(id)}`, okResponseSchema, body),
  deleteChannel: (id: string) =>
    api('DELETE', `/channels/${encodeURIComponent(id)}`, okResponseSchema),
  subscribeChannel: (id: string) =>
    api('POST', `/channels/${encodeURIComponent(id)}/subscription`, okResponseSchema, {}),
  unsubscribeChannel: (id: string) =>
    api('DELETE', `/channels/${encodeURIComponent(id)}/subscription`, okResponseSchema),
  channelAdmins: (id: string) =>
    api('GET', `/channels/${encodeURIComponent(id)}/admins`, channelAdminListSchema),
  addChannelAdmin: (id: string, username: string, permissions: number) =>
    api('POST', `/channels/${encodeURIComponent(id)}/admins`, okResponseSchema, {
      username,
      permissions,
    }),
  setChannelAdmin: (id: string, userId: string, permissions: number) =>
    api(
      'PUT',
      `/channels/${encodeURIComponent(id)}/admins/${encodeURIComponent(userId)}`,
      okResponseSchema,
      { permissions },
    ),
  removeChannelAdmin: (id: string, userId: string) =>
    api(
      'DELETE',
      `/channels/${encodeURIComponent(id)}/admins/${encodeURIComponent(userId)}`,
      okResponseSchema,
    ),
  requestChannelTransfer: (id: string, userId: string) =>
    api(
      'POST',
      `/channels/${encodeURIComponent(id)}/ownership`,
      z.object({ effectiveAt: z.string() }),
      { userId },
    ),
  cancelChannelTransfer: (id: string) =>
    api('DELETE', `/channels/${encodeURIComponent(id)}/ownership`, okResponseSchema),
  createChannelLink: (id: string, body: { expiresInHours: number; maxUses: number | null }) =>
    api('POST', `/channels/${encodeURIComponent(id)}/links`, createdChannelLinkSchema, body),
  channelLinks: (id: string) =>
    api('GET', `/channels/${encodeURIComponent(id)}/links`, channelLinkListSchema),
  revokeChannelLink: (id: string, linkId: string) =>
    api(
      'DELETE',
      `/channels/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`,
      okResponseSchema,
    ),
  previewChannelInvite: (token: string) =>
    api('GET', `/channel-invites/${encodeURIComponent(token)}`, channelInvitePreviewSchema),
  joinChannelInvite: (token: string) =>
    api(
      'POST',
      `/channel-invites/${encodeURIComponent(token)}/subscription`,
      z.object({ id: z.string() }),
      {},
    ),
  channelPosts: (
    id: string,
    query: { before?: string; status?: 'published' | 'draft' | 'scheduled'; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.before !== undefined) params.set('before', query.before);
    if (query.status !== undefined) params.set('status', query.status);
    params.set('limit', String(query.limit ?? 20));
    return api(
      'GET',
      `/channels/${encodeURIComponent(id)}/posts?${params.toString()}`,
      postListSchema,
    );
  },
  searchChannel: (id: string, q: string) =>
    api(
      'GET',
      `/channels/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}`,
      postListSchema,
    ),
  createChannelPost: (
    id: string,
    body: {
      body: string;
      previewUrl: string | null;
      poll: {
        question: string;
        options: string[];
        multiple: boolean;
        anonymous: boolean;
      } | null;
      publish: string;
    },
  ) => api('POST', `/channels/${encodeURIComponent(id)}/posts`, channelPostSchema, body),
  updateChannelPost: (id: string, postId: string, body: string) =>
    api(
      'PATCH',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}`,
      channelPostSchema,
      { body },
    ),
  publishChannelPost: (id: string, postId: string) =>
    api(
      'POST',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/publish`,
      channelPostSchema,
      {},
    ),
  deleteChannelPost: (id: string, postId: string) =>
    api(
      'DELETE',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}`,
      okResponseSchema,
    ),
  reactToChannelPost: (id: string, postId: string, emoji: string | null) =>
    api(
      'PUT',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/reaction`,
      channelPostSchema,
      { emoji },
    ),
  voteInChannelPoll: (id: string, postId: string, choices: number[]) =>
    api(
      'PUT',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/vote`,
      channelPostSchema,
      { choices },
    ),
  channelPollVoters: (id: string, postId: string) =>
    api(
      'GET',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/voters`,
      pollVotersSchema,
    ),
  channelComments: (id: string, postId: string, after?: string) =>
    api(
      'GET',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/comments${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`,
      commentListSchema,
    ),
  addChannelComment: (id: string, postId: string, body: string) =>
    api(
      'POST',
      `/channels/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/comments`,
      commentSchema,
      { body },
    ),
  deleteChannelComment: (id: string, commentId: string) =>
    api(
      'DELETE',
      `/channels/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      okResponseSchema,
    ),
  recordChannelViews: (id: string, postIds: string[]) =>
    api('POST', `/channels/${encodeURIComponent(id)}/views`, okResponseSchema, { postIds }),
  channelAnalytics: (id: string) =>
    api('GET', `/channels/${encodeURIComponent(id)}/analytics`, channelAnalyticsSchema),
  linkPreview: (url: string) =>
    api('POST', '/link-previews', linkPreviewSchema.nullable(), { url }),

  // ---- calls (docs/calling.md): the server never sees signalling or media ----
  callCapabilities: () => api('GET', '/calls/capabilities', callCapabilitiesSchema),
  iceServers: () => api('POST', '/calls/ice', iceConfigSchema, {}),
  startCall: (conversationId: string, media: 'audio' | 'video', deviceId: string) =>
    api('POST', '/calls', startedCallSchema, { conversationId, media, deviceId }),
  call: (callId: string) => api('GET', `/calls/${encodeURIComponent(callId)}`, callSchema),
  activeCall: (conversationId: string) =>
    api('GET', `/conversations/${encodeURIComponent(conversationId)}/call`, activeCallSchema),
  joinCall: (callId: string, deviceId: string) =>
    api('POST', `/calls/${encodeURIComponent(callId)}/join`, joinedCallSchema, { deviceId }),
  leaveCall: (
    callId: string,
    deviceId: string,
    reason: 'hangup' | 'declined' | 'busy' | 'failed' | 'missed',
  ) => api('POST', `/calls/${encodeURIComponent(callId)}/leave`, callSchema, { deviceId, reason }),
  callHeartbeat: (callId: string, deviceId: string) =>
    api('POST', `/calls/${encodeURIComponent(callId)}/heartbeat`, okResponseSchema, { deviceId }),

  // ---- notifications (docs/notifications.md) ----
  notificationConfig: () => api('GET', '/notifications/config', notificationConfigSchema),
  subscribePush: (subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    deviceId: string;
  }) => api('PUT', '/notifications/push-subscription', okResponseSchema, subscription),
  unsubscribePush: () => api('DELETE', '/notifications/push-subscription', okResponseSchema),
  notificationPreferences: () =>
    api('GET', '/notifications/preferences', notificationPreferencesSchema),
  setNotificationPreferences: (preferences: NotificationPreferences) =>
    api('PUT', '/notifications/preferences', notificationPreferencesSchema, preferences),
  mutes: () => api('GET', '/notifications/mutes', conversationMutesSchema),
  mute: (conversationId: string, until: string | null) =>
    api('PUT', `/conversations/${encodeURIComponent(conversationId)}/mute`, okResponseSchema, {
      until,
    }),
  unmute: (conversationId: string) =>
    api('DELETE', `/conversations/${encodeURIComponent(conversationId)}/mute`, okResponseSchema),
  securityAlerts: () => api('GET', '/security-alerts', securityAlertsSchema),
  markAlertsRead: (upTo: string) =>
    api('POST', '/security-alerts/read', okResponseSchema, { upTo }),
  setChannelNotifications: (channelId: string, enabled: boolean) =>
    api('PUT', `/channels/${encodeURIComponent(channelId)}/notifications`, okResponseSchema, {
      enabled,
    }),

  // ---- communities (docs/groups.md §5) ----
  myCommunities: () => api('GET', '/communities', communityListSchema),
  discoverCommunities: (q: string) =>
    api('GET', `/community-directory?q=${encodeURIComponent(q)}`, communityListSchema),
  community: (id: string) => api('GET', `/communities/${encodeURIComponent(id)}`, communitySchema),
  createCommunity: (body: {
    name: string;
    description: string;
    visibility: 'public' | 'private';
    rules: string;
    minAccountAgeDays: number;
  }) => api('POST', '/communities', z.object({ id: z.string() }), body),
  updateCommunity: (
    id: string,
    body: Partial<{
      name: string;
      description: string;
      visibility: 'public' | 'private';
      rules: string;
      minAccountAgeDays: number;
    }>,
  ) => api('PATCH', `/communities/${encodeURIComponent(id)}`, okResponseSchema, body),
  deleteCommunity: (id: string) =>
    api('DELETE', `/communities/${encodeURIComponent(id)}`, okResponseSchema),
  joinCommunity: (id: string, rulesVersion: number) =>
    api('POST', `/communities/${encodeURIComponent(id)}/join`, okResponseSchema, { rulesVersion }),
  leaveCommunity: (id: string) =>
    api('POST', `/communities/${encodeURIComponent(id)}/leave`, okResponseSchema, {}),
  communityMembers: (id: string, cursor?: string) =>
    api(
      'GET',
      `/communities/${encodeURIComponent(id)}/members${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      communityMemberListSchema,
    ),
  transferCommunity: (id: string, userId: string) =>
    api('POST', `/communities/${encodeURIComponent(id)}/owner`, okResponseSchema, { userId }),
  createCommunityRole: (
    id: string,
    body: { name: string; position: number; permissions: number },
  ) =>
    api('POST', `/communities/${encodeURIComponent(id)}/roles`, z.object({ id: z.string() }), body),
  updateCommunityRole: (
    id: string,
    roleId: string,
    body: Partial<{ name: string; position: number; permissions: number }>,
  ) =>
    api(
      'PATCH',
      `/communities/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`,
      okResponseSchema,
      body,
    ),
  deleteCommunityRole: (id: string, roleId: string) =>
    api(
      'DELETE',
      `/communities/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`,
      okResponseSchema,
    ),
  setCommunityMemberRoles: (id: string, userId: string, roleIds: readonly string[]) =>
    api(
      'PUT',
      `/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/roles`,
      okResponseSchema,
      { roleIds },
    ),
  kickFromCommunity: (id: string, userId: string) =>
    api(
      'DELETE',
      `/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      okResponseSchema,
    ),
  banFromCommunity: (id: string, userId: string) =>
    api('POST', `/communities/${encodeURIComponent(id)}/bans`, okResponseSchema, { userId }),
  communityBans: (id: string) =>
    api('GET', `/communities/${encodeURIComponent(id)}/bans`, communityBanListSchema),
  unbanFromCommunity: (id: string, userId: string) =>
    api(
      'DELETE',
      `/communities/${encodeURIComponent(id)}/bans/${encodeURIComponent(userId)}`,
      okResponseSchema,
    ),
  createCommunityLink: (id: string, body: { expiresInHours: number; maxUses: number | null }) =>
    api('POST', `/communities/${encodeURIComponent(id)}/links`, createdCommunityLinkSchema, body),
  communityLinks: (id: string) =>
    api('GET', `/communities/${encodeURIComponent(id)}/links`, communityLinkListSchema),
  revokeCommunityLink: (id: string, linkId: string) =>
    api(
      'DELETE',
      `/communities/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`,
      okResponseSchema,
    ),
  previewCommunityInvite: (token: string) =>
    api('GET', `/community-invites/${encodeURIComponent(token)}`, communityInvitePreviewSchema),
  joinCommunityInvite: (token: string, rulesVersion: number) =>
    api(
      'POST',
      `/community-invites/${encodeURIComponent(token)}/join`,
      z.object({ id: z.string() }),
      { rulesVersion },
    ),
  createSpace: (
    id: string,
    body: { name: string; roleIds: readonly string[]; autoApprove: boolean; ciphersuite: number },
  ) =>
    api(
      'POST',
      `/communities/${encodeURIComponent(id)}/spaces`,
      z.object({ id: z.string() }),
      body,
    ),
  spaces: (id: string) =>
    api('GET', `/communities/${encodeURIComponent(id)}/spaces`, spaceListSchema),
  deleteSpace: (id: string, spaceId: string) =>
    api(
      'DELETE',
      `/communities/${encodeURIComponent(id)}/spaces/${encodeURIComponent(spaceId)}`,
      okResponseSchema,
    ),
  joinSpace: (id: string, spaceId: string) =>
    api(
      'POST',
      `/communities/${encodeURIComponent(id)}/spaces/${encodeURIComponent(spaceId)}/join`,
      joinSpaceResponseSchema,
      {},
    ),
  mySpaces: () => api('GET', '/community-spaces', mySpacesSchema),

  // ---- groups (docs/groups.md) ----
  createGroup: (usernames: readonly string[], ciphersuite: number) =>
    api('POST', '/groups', createGroupResponseSchema, { usernames, ciphersuite }),
  addMembers: (id: string, usernames: readonly string[]) =>
    api('POST', `/groups/${encodeURIComponent(id)}/members`, addMembersResultSchema, {
      usernames,
    }),
  removeMember: (id: string, userId: string) =>
    api(
      'DELETE',
      `/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      okResponseSchema,
    ),
  banMember: (id: string, userId: string) =>
    api('POST', `/groups/${encodeURIComponent(id)}/bans`, okResponseSchema, { userId }),
  bans: (id: string) => api('GET', `/groups/${encodeURIComponent(id)}/bans`, banListSchema),
  unban: (id: string, userId: string) =>
    api(
      'DELETE',
      `/groups/${encodeURIComponent(id)}/bans/${encodeURIComponent(userId)}`,
      okResponseSchema,
    ),
  leaveGroup: (id: string) =>
    api('POST', `/groups/${encodeURIComponent(id)}/leave`, okResponseSchema, {}),
  setRole: (id: string, userId: string, role: 'admin' | 'member') =>
    api(
      'PUT',
      `/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/role`,
      okResponseSchema,
      { role },
    ),
  transferOwnership: (id: string, userId: string) =>
    api('POST', `/groups/${encodeURIComponent(id)}/owner`, okResponseSchema, { userId }),
  updateGroupSettings: (id: string, settings: GroupSettings) =>
    api('PUT', `/groups/${encodeURIComponent(id)}/settings`, okResponseSchema, settings),
  deleteGroup: (id: string) => api('DELETE', `/groups/${encodeURIComponent(id)}`, okResponseSchema),
  groupInvitations: () => api('GET', '/group-invitations', invitationListSchema),
  acceptInvitation: (id: string) =>
    api('POST', `/group-invitations/${encodeURIComponent(id)}/accept`, okResponseSchema, {}),
  declineInvitation: (id: string) =>
    api('DELETE', `/group-invitations/${encodeURIComponent(id)}`, okResponseSchema),
  createInviteLink: (
    id: string,
    body: { expiresInHours: number; maxUses: number | null; previewTitle: string | null },
  ) => api('POST', `/groups/${encodeURIComponent(id)}/links`, createdInviteLinkSchema, body),
  inviteLinks: (id: string) =>
    api('GET', `/groups/${encodeURIComponent(id)}/links`, inviteLinkListSchema),
  revokeInviteLink: (id: string, linkId: string) =>
    api(
      'DELETE',
      `/groups/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`,
      okResponseSchema,
    ),
  previewInvite: (token: string) =>
    api('GET', `/invites/${encodeURIComponent(token)}`, invitePreviewSchema),
  requestJoin: (token: string) =>
    api(
      'POST',
      `/invites/${encodeURIComponent(token)}/join`,
      z.object({ groupId: z.string().nullable() }),
      {},
    ),
  joinRequests: (id: string) =>
    api('GET', `/groups/${encodeURIComponent(id)}/requests`, joinRequestListSchema),
  approveJoinRequest: (id: string, userId: string) =>
    api(
      'POST',
      `/groups/${encodeURIComponent(id)}/requests/${encodeURIComponent(userId)}/approve`,
      okResponseSchema,
      {},
    ),
  rejectJoinRequest: (id: string, userId: string) =>
    api(
      'DELETE',
      `/groups/${encodeURIComponent(id)}/requests/${encodeURIComponent(userId)}`,
      okResponseSchema,
    ),
  sendMessage: (
    id: string,
    body: {
      clientMessageId: string;
      senderDeviceId: string;
      epoch: number;
      ciphertext: string;
      attachments?: readonly string[];
    },
  ) =>
    api(
      'POST',
      `/conversations/${encodeURIComponent(id)}/messages`,
      sendMessageResponseSchema,
      body,
    ),
  messages: (id: string, query: { after?: number; before?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (query.after !== undefined) params.set('after', String(query.after));
    if (query.before !== undefined) params.set('before', String(query.before));
    params.set('limit', String(query.limit ?? 50));
    return api(
      'GET',
      `/conversations/${encodeURIComponent(id)}/messages?${params.toString()}`,
      messageListSchema,
    );
  },
  ack: (id: string, seq: number) =>
    api('POST', `/conversations/${encodeURIComponent(id)}/ack`, okResponseSchema, { seq }),
  sync: () => api('GET', '/sync', syncResponseSchema),
  setDisappearing: (id: string, seconds: 0 | 86400 | 604800 | 7776000) =>
    api('PUT', `/conversations/${encodeURIComponent(id)}/disappearing`, conversationSchema, {
      seconds,
    }),
  commit: (
    id: string,
    body: {
      clientMessageId: string;
      senderDeviceId: string;
      epoch: number;
      commit: string;
      welcome: string | null;
      welcomeTargets: readonly { userId: string; deviceId: string }[];
    },
  ) => api('POST', `/conversations/${encodeURIComponent(id)}/commits`, commitResponseSchema, body),
  welcomes: (deviceId: string) =>
    api('GET', `/welcomes?deviceId=${encodeURIComponent(deviceId)}`, welcomeListSchema),
  ackWelcome: (id: string) =>
    api('DELETE', `/welcomes/${encodeURIComponent(id)}`, okResponseSchema),

  ownKeys: () => api('GET', '/keys/me', ownKeysSchema),
  userKeys: (userId: string) =>
    api('GET', `/keys/users/${encodeURIComponent(userId)}`, userKeysSchema),
  registerDevice: (body: RegisterDevice) => api('POST', '/keys/devices', ownKeysSchema, body),
  resetIdentity: (body: RegisterDevice) => api('POST', '/keys/identity/reset', ownKeysSchema, body),
  keyPackageCount: (deviceId: string) =>
    api('GET', `/keys/devices/${encodeURIComponent(deviceId)}/key-packages`, keyPackageCountSchema),
  uploadKeyPackages: (deviceId: string, keyPackages: string[], lastResortKeyPackage?: string) =>
    api(
      'POST',
      `/keys/devices/${encodeURIComponent(deviceId)}/key-packages`,
      keyPackageCountSchema,
      lastResortKeyPackage === undefined ? { keyPackages } : { keyPackages, lastResortKeyPackage },
    ),
  claimKeyPackages: (userId: string) =>
    api('POST', '/keys/claim', claimedKeyPackagesSchema, { userId }),

  // ---- multi-device (docs/multi-device.md) ----
  addDevice: (body: AddDevice) => api('POST', '/keys/devices/linked', ownKeysSchema, body),
  revokeDevice: (deviceId: string) =>
    api('DELETE', `/keys/devices/${encodeURIComponent(deviceId)}`, ownKeysSchema),
  createLink: (body: CreateLink) => api('POST', '/keys/links', linkCreatedSchema, body),
  /** `shortId` is base64url (7 characters). */
  lookupLink: (shortId: string) =>
    api('GET', `/keys/links/by-code/${encodeURIComponent(shortId)}`, linkRequestSchema),
  approveLink: (linkId: string, body: { approverDeviceId: string; sealed: string }) =>
    api('POST', `/keys/links/${encodeURIComponent(linkId)}/approve`, okResponseSchema, body),
  linkStatus: (linkId: string) =>
    api('GET', `/keys/links/${encodeURIComponent(linkId)}`, linkStatusSchema),

  // ---- encrypted backups (docs/encrypted-backups.md) ----
  backupStatus: () => api('GET', '/backups', backupStatusSchema),
  addBackupKey: (body: AddBackupWrap) =>
    api('POST', '/backups/keys', z.object({ id: z.string() }), body),
  removeBackupKey: (id: string) =>
    api('DELETE', `/backups/keys/${encodeURIComponent(id)}`, okResponseSchema),
  uploadBackup: (body: UploadBackup) =>
    api('POST', '/backups/versions', z.object({ version: z.number() }), body),
  latestBackup: () => api('GET', '/backups/latest', backupDownloadSchema),
  disableBackups: () => api('DELETE', '/backups', okResponseSchema),

  // ---- encrypted attachments (docs/media.md) ----
  createUpload: (size: number) => api('POST', '/media/uploads', uploadCreatedSchema, { size }),
  uploadParts: (blobId: string, partNumbers: number[]) =>
    api('POST', `/media/uploads/${encodeURIComponent(blobId)}/parts`, uploadPartsResponseSchema, {
      partNumbers,
    }),
  completeUpload: (blobId: string, parts: { partNumber: number; etag: string }[]) =>
    api(
      'POST',
      `/media/uploads/${encodeURIComponent(blobId)}/complete`,
      z.object({ blobId: z.string() }),
      { parts },
    ),
  abortUpload: (blobId: string) =>
    api('DELETE', `/media/uploads/${encodeURIComponent(blobId)}`, okResponseSchema),
  mediaDownload: (blobId: string) =>
    api('GET', `/media/${encodeURIComponent(blobId)}`, mediaDownloadSchema),

  realtimeTicket: () => api('POST', '/realtime/ticket', realtimeTicketSchema, {}),
  presence: (userId: string) =>
    api('GET', `/presence/${encodeURIComponent(userId)}`, presenceSchema),
};
