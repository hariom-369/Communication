import { idSchema, presenceSchema, realtimeTicketSchema } from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';

import { TICKET_TTL_SECONDS, type RealtimeService } from './realtime.js';

export interface RealtimeModuleDeps {
  readonly realtime: RealtimeService;
  /** Path of the WebSocket endpoint relative to the web origin (routed to services/realtime). */
  readonly websocketPath: string;
}

export function realtimeRoutes(deps: RealtimeModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'realtime.ticket',
      method: 'POST',
      url: '/api/v1/realtime/ticket',
      summary: 'Single-use, 30-second ticket to open the realtime WebSocket',
      tags: ['realtime'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: {
        name: 'realtime.ticket',
        limit: 60,
        periodMs: 60_000,
        burst: 20,
        onStoreFailure: 'closed',
      },
      audit: { kind: 'none', reason: 'Short-lived connection credential' },
      schema: { body: z.strictObject({}), response: realtimeTicketSchema },
      successStatus: 201,
      handler: async (_input, context) => ({
        ticket: await deps.realtime.issueTicket(context.session.userId, context.session.id),
        url: deps.websocketPath,
        expiresInSeconds: TICKET_TTL_SECONDS,
      }),
    }),
    defineRoute({
      id: 'realtime.presence',
      method: 'GET',
      url: '/api/v1/presence/:userId',
      summary: "A user's online status and last seen, as permitted by their privacy settings",
      tags: ['realtime'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: {
        name: 'realtime.presence',
        limit: 240,
        periodMs: 60_000,
        burst: 60,
        onStoreFailure: 'open',
      },
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { params: z.strictObject({ userId: idSchema }), response: presenceSchema },
      successStatus: 200,
      handler: async ({ params }, context) => ({
        userId: params.userId,
        ...(await deps.realtime.presence(context.session.userId, params.userId)),
      }),
    }),
  ];
}
