import { z } from 'zod';

import { mailboxMessageSchema } from './messaging.js';

/**
 * WebSocket frames (docs/realtime.md §4), subprotocol `tessera.v1`, JSON text frames validated on
 * both ends. Every client request carries an `id`; the server answers with `ack` or `error`.
 */
export const REALTIME_SUBPROTOCOL = 'tessera.v1';
export const MAX_CLIENT_FRAME_BYTES = 4 * 1024;

const frameId = z.string().min(1).max(64);

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auth'), id: frameId, ticket: z.string().max(128) }),
  z.strictObject({
    type: z.literal('typing'),
    id: frameId,
    conversationId: z.string().max(64),
    state: z.enum(['start', 'stop']),
  }),
  z.strictObject({ type: z.literal('ping'), id: frameId }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const serverFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), heartbeatSeconds: z.number() }),
  z.object({ type: z.literal('ack'), id: z.string() }),
  z.object({
    type: z.literal('error'),
    id: z.string().nullable(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('message'),
    conversationId: z.string(),
    message: mailboxMessageSchema,
  }),
  z.object({
    type: z.literal('receipt'),
    conversationId: z.string(),
    userId: z.string(),
    seq: z.number(),
  }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.string(),
    userId: z.string(),
    state: z.enum(['start', 'stop']),
  }),
  z.object({ type: z.literal('conversation'), conversationId: z.string() }),
  /** A Welcome is waiting for one of this user's devices. */
  z.object({ type: z.literal('welcome'), conversationId: z.string() }),
  /** A contact's keys changed (new device, identity reset): re-fetch and re-check. */
  z.object({ type: z.literal('keys_changed'), userId: z.string() }),
  /** An existing device approved a device-link request of this user. */
  z.object({ type: z.literal('link_approved'), linkId: z.string() }),
  /** Someone asked to join a group this user administers. */
  z.object({ type: z.literal('group_requests'), conversationId: z.string() }),
  /** Something about a community this user belongs to changed (roles, spaces, membership). */
  z.object({ type: z.literal('community'), communityId: z.string() }),
  z.object({ type: z.literal('reconnect'), afterMs: z.number() }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

/**
 * Events published by the API for the realtime tier on `<prefix>:rt:user:<userId>`. Realtime
 * hints are best-effort; durability comes from the mailbox and client sync (docs/messaging.md §3).
 */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    conversationId: z.string(),
    message: mailboxMessageSchema,
  }),
  z.object({
    type: z.literal('receipt'),
    conversationId: z.string(),
    userId: z.string(),
    seq: z.number(),
  }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.string(),
    userId: z.string(),
    state: z.enum(['start', 'stop']),
  }),
  z.object({ type: z.literal('conversation'), conversationId: z.string() }),
  z.object({ type: z.literal('welcome'), conversationId: z.string() }),
  z.object({ type: z.literal('keys_changed'), userId: z.string() }),
  z.object({ type: z.literal('link_approved'), linkId: z.string() }),
  /** Someone asked to join a group this user administers. */
  z.object({ type: z.literal('group_requests'), conversationId: z.string() }),
  z.object({ type: z.literal('community'), communityId: z.string() }),
  /** Sessions of this user were revoked or rotated; realtime re-validates open connections. */
  z.object({ type: z.literal('sessions_changed') }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export function userChannel(prefix: string, userId: string): string {
  return `${prefix}:rt:user:${userId}`;
}
