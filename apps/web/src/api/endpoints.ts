import {
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
  sendMessage: (id: string, body: { clientMessageId: string; epoch: number; ciphertext: string }) =>
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
  realtimeTicket: () => api('POST', '/realtime/ticket', realtimeTicketSchema, {}),
  presence: (userId: string) =>
    api('GET', `/presence/${encodeURIComponent(userId)}`, presenceSchema),
};
