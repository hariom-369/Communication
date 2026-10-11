import { idSchema, presenceSchema, realtimeTicketSchema } from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';

import { TICKET_TTL_SECONDS, type RealtimeService } from './realtime.js';

export interface RealtimeModuleDeps {
  readonly realtime: RealtimeService;
  /** Path of the WebSocket endpoint relative to the web origin (routed to services/realtime). */
  readonly websocketPath: string;
  /**
   * Tickets issued per second across all API processes (admission control, docs/capacity.md
   * §4). When a realtime pod fails, all of its clients reconnect at once; refusing the excess
   * (429 with Retry-After, the clients back off and retry) spreads the wave so the people already
   * connected keep sending without delay. Absent: no limit.
   */
  readonly ticketsPerSecond?: number;
}

export function realtimeRoutes(deps: RealtimeModuleDeps): RouteDefinition[] {
  const admission =
    deps.ticketsPerSecond === undefined
      ? null
      : {
          name: 'realtime.ticket.admission',
          limit: deps.ticketsPerSecond,
          periodMs: 1000,
          burst: deps.ticketsPerSecond,
          // A limiter outage must not keep anyone offline.
          onStoreFailure: 'open' as const,
        };
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
      handler: async (_input, context) => {
        // One shared budget for the whole cluster (the subject is the same for everyone).
        if (admission !== null) await context.rateLimit(admission, 'cluster');
        return {
          ticket: await deps.realtime.issueTicket(context.session.userId, context.session.id),
          url: deps.websocketPath,
          expiresInSeconds: TICKET_TTL_SECONDS,
        };
      },
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
