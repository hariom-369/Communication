import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Voice and video calls (docs/calling.md, ADR-016/017/047). The server never handles call
 * content or signalling: offers, answers and network candidates travel inside end-to-end
 * encrypted messages. It keeps a minimal call record, issues short-lived TURN credentials and
 * SFU tokens, and checks who may join.
 */

export const CALL_MEDIA = ['audio', 'video'] as const;
export const CALL_MODES = ['p2p', 'sfu'] as const;
export const CALL_STATES = ['ringing', 'active', 'ended'] as const;
export const CALL_END_REASONS = [
  'hangup',
  'declined',
  'busy',
  'missed',
  'failed',
  'removed',
] as const;
/** A call nobody answers stops ringing after this long. */
export const CALL_RING_SECONDS = 45;
/** Participants confirm they are still in a call this often; silence for 3× ends their part. */
export const CALL_HEARTBEAT_SECONDS = 20;
/** Launch limits (docs/calling.md §3). */
export const MAX_SFU_VIDEO_PARTICIPANTS = 32;
export const MAX_SFU_PARTICIPANTS = 100;

export const startCallSchema = z.strictObject({
  conversationId: idSchema,
  media: z.enum(CALL_MEDIA),
  /** This browser's device; must be an active device of the caller. */
  deviceId: idSchema,
});
export type StartCall = z.infer<typeof startCallSchema>;

export const callParamsSchema = z.strictObject({ callId: idSchema });
export const conversationCallParamsSchema = z.strictObject({ conversationId: idSchema });

export const callDeviceSchema = z.strictObject({ deviceId: idSchema });

export const leaveCallSchema = z.strictObject({
  deviceId: idSchema,
  reason: z.enum(CALL_END_REASONS).default('hangup'),
});

export const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const iceConfigSchema = z.object({
  iceServers: z.array(iceServerSchema),
  /** Whether a TURN relay is configured (needed to hide your address from the other person). */
  relayAvailable: z.boolean(),
  /** Seconds until the credentials stop working. */
  ttlSeconds: z.number().int(),
});
export type IceConfig = z.infer<typeof iceConfigSchema>;

export const callSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  mode: z.enum(CALL_MODES),
  media: z.enum(CALL_MEDIA),
  state: z.enum(CALL_STATES),
  initiatorUserId: z.string(),
  initiatorDeviceId: z.string(),
  startedAt: z.string(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z.enum(CALL_END_REASONS).nullable(),
  participantCount: z.number().int(),
});
export type CallRecord = z.infer<typeof callSchema>;

export const startedCallSchema = z.object({
  call: callSchema,
  /** False when a call was already going on in the conversation: join that one instead. */
  created: z.boolean(),
  ice: iceConfigSchema,
});

export const sfuAccessSchema = z.object({
  /** WebSocket URL of the SFU; relative URLs are on the web origin. */
  url: z.string(),
  /** Short-lived (5 minutes) join token for this call's room only. */
  token: z.string(),
});

export const joinedCallSchema = z.object({
  call: callSchema,
  ice: iceConfigSchema,
  sfu: sfuAccessSchema.nullable(),
});

export const activeCallSchema = z.object({ call: callSchema.nullable() });

export const callCapabilitiesSchema = z.object({
  relayAvailable: z.boolean(),
  groupCallsAvailable: z.boolean(),
});
