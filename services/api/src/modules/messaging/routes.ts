import { AppError } from '@tessera/platform';
import {
  ackSchema,
  commitResponseSchema,
  commitSchema,
  MAX_COMMIT_BYTES,
  MAX_WELCOME_BYTES,
  conversationListQuerySchema,
  conversationListSchema,
  conversationSchema,
  createDirectConversationSchema,
  idSchema,
  messageListQuerySchema,
  messageListSchema,
  okResponseSchema,
  sendMessageResponseSchema,
  sendMessageSchema,
  setDisappearingSchema,
  syncResponseSchema,
  welcomeListQuerySchema,
  welcomeListSchema,
} from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { MessagingService } from './messaging.js';

export interface MessagingModuleDeps {
  readonly messaging: MessagingService;
}

/** docs/messaging.md §8: 20/s burst, 300/min sustained per user. */
const limits = {
  send: { name: 'messaging.send', limit: 300, periodMs: 60_000, burst: 20, onStoreFailure: 'open' },
  open: {
    name: 'messaging.open',
    limit: 60,
    periodMs: 3_600_000,
    burst: 20,
    onStoreFailure: 'closed',
  },
  read: {
    name: 'messaging.read',
    limit: 600,
    periodMs: 60_000,
    burst: 120,
    onStoreFailure: 'open',
  },
  ack: { name: 'messaging.ack', limit: 600, periodMs: 60_000, burst: 120, onStoreFailure: 'open' },
  settings: {
    name: 'messaging.settings',
    limit: 30,
    periodMs: 60_000,
    burst: 10,
    onStoreFailure: 'open',
  },
} satisfies Record<string, RateLimitPolicy>;

const conversationParams = z.strictObject({ id: idSchema });

export function messagingRoutes(deps: MessagingModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'messaging.open_direct',
      method: 'POST',
      url: '/api/v1/conversations/direct',
      summary: 'Find or create the direct conversation with a user',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.open,
      audit: { kind: 'none', reason: 'Conversation metadata; no security-relevant change' },
      schema: { body: createDirectConversationSchema, response: conversationSchema },
      successStatus: 200,
      handler: ({ body }, context) =>
        deps.messaging.openDirect(context.session.userId, body.username, body.ciphersuite),
    }),
    defineRoute({
      id: 'messaging.list_conversations',
      method: 'GET',
      url: '/api/v1/conversations',
      summary: 'Conversations of the signed-in user, most recent first (cursor pagination)',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { querystring: conversationListQuerySchema, response: conversationListSchema },
      successStatus: 200,
      handler: ({ query }, context) =>
        deps.messaging.list(context.session.userId, query.limit, query.cursor),
    }),
    defineRoute({
      id: 'messaging.get_conversation',
      method: 'GET',
      url: '/api/v1/conversations/:id',
      summary: 'One conversation',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { params: conversationParams, response: conversationSchema },
      successStatus: 200,
      handler: ({ params }, context) => deps.messaging.get(context.session.userId, params.id),
    }),
    defineRoute({
      id: 'messaging.send',
      method: 'POST',
      url: '/api/v1/conversations/:id/messages',
      summary: 'Append an encrypted message (idempotent on clientMessageId)',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.send,
      audit: { kind: 'none', reason: 'Message traffic is not audited (metadata minimisation)' },
      schema: {
        params: conversationParams,
        body: sendMessageSchema,
        response: sendMessageResponseSchema,
      },
      successStatus: 201,
      // 64 KiB of ciphertext is ~88 KB as base64 inside JSON.
      bodyLimit: 96 * 1024,
      handler: async ({ params, body }, context) => {
        const ciphertext = Buffer.from(body.ciphertext, 'base64');
        if (ciphertext.length === 0)
          throw new AppError('BAD_REQUEST', { detail: 'Empty message.' });
        const result = await deps.messaging.send(context.session.userId, params.id, {
          clientMessageId: body.clientMessageId,
          senderDeviceId: body.senderDeviceId,
          epoch: body.epoch,
          ciphertext,
          attachments: body.attachments,
          commitment:
            body.commitment === undefined ? undefined : Buffer.from(body.commitment, 'base64'),
        });
        return {
          seq: result.message.seq,
          serverTime: result.message.serverTime,
          duplicate: result.duplicate,
        };
      },
    }),
    defineRoute({
      id: 'messaging.list_messages',
      method: 'GET',
      url: '/api/v1/conversations/:id/messages',
      summary: 'Encrypted messages after or before a sequence number',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: {
        params: conversationParams,
        querystring: messageListQuerySchema,
        response: messageListSchema,
      },
      successStatus: 200,
      handler: ({ params, query }, context) =>
        deps.messaging.messages(context.session.userId, params.id, query),
    }),
    defineRoute({
      id: 'messaging.ack',
      method: 'POST',
      url: '/api/v1/conversations/:id/ack',
      summary: 'Acknowledge delivery up to a sequence number',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.ack,
      audit: { kind: 'none', reason: 'Delivery state only' },
      schema: { params: conversationParams, body: ackSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await deps.messaging.acknowledge(context.session.userId, params.id, body.seq);
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'messaging.commit',
      method: 'POST',
      url: '/api/v1/conversations/:id/commits',
      summary: 'Append an MLS commit for the current epoch (compare-and-set; 409 if another won)',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.send,
      audit: {
        kind: 'none',
        reason: 'Group key updates are message traffic (metadata minimisation)',
      },
      schema: { params: conversationParams, body: commitSchema, response: commitResponseSchema },
      successStatus: 201,
      // Commit and Welcome (≤ 1 MiB each, ADR-044) as base64 inside JSON, plus targets.
      bodyLimit: Math.ceil(((MAX_COMMIT_BYTES + MAX_WELCOME_BYTES) * 4) / 3) + 256 * 1024,
      handler: async ({ params, body }, context) => {
        const commit = Buffer.from(body.commit, 'base64');
        if (commit.length === 0) throw new AppError('BAD_REQUEST', { detail: 'Empty commit.' });
        const result = await deps.messaging.commit(context.session.userId, params.id, {
          clientMessageId: body.clientMessageId,
          senderDeviceId: body.senderDeviceId,
          epoch: body.epoch,
          commit,
          welcome: body.welcome === null ? null : Buffer.from(body.welcome, 'base64'),
          welcomeTargets: body.welcomeTargets,
        });
        return {
          seq: result.message.seq,
          epoch: result.epoch,
          serverTime: result.message.serverTime,
          duplicate: result.duplicate,
        };
      },
    }),
    defineRoute({
      id: 'messaging.list_welcomes',
      method: 'GET',
      url: '/api/v1/welcomes',
      summary: 'MLS Welcomes waiting for one of your devices',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { querystring: welcomeListQuerySchema, response: welcomeListSchema },
      successStatus: 200,
      handler: async ({ query }, context) => ({
        welcomes: await deps.messaging.welcomes(context.session.userId, query.deviceId),
      }),
    }),
    defineRoute({
      id: 'messaging.ack_welcome',
      method: 'DELETE',
      url: '/api/v1/welcomes/:id',
      summary: 'Discard a Welcome after processing it',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.ack,
      audit: { kind: 'none', reason: 'Delivery state only' },
      schema: { params: conversationParams, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await deps.messaging.acknowledgeWelcome(context.session.userId, params.id);
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'messaging.sync',
      method: 'GET',
      url: '/api/v1/sync',
      summary: 'Per-conversation positions for catching up after reconnecting',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: syncResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => ({
        conversations: await deps.messaging.sync(context.session.userId),
      }),
    }),
    defineRoute({
      id: 'messaging.set_disappearing',
      method: 'PUT',
      url: '/api/v1/conversations/:id/disappearing',
      summary: 'Set the disappearing-message timer (server deletes ciphertext accordingly)',
      tags: ['messaging'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.settings,
      audit: { kind: 'none', reason: 'Conversation setting; announced to members in-conversation' },
      schema: {
        params: conversationParams,
        body: setDisappearingSchema,
        response: conversationSchema,
      },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        deps.messaging.setDisappearing(context.session.userId, params.id, body.seconds),
    }),
  ];
}
