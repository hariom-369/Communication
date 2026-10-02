import {
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
