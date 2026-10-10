import {
  activeCallSchema,
  callCapabilitiesSchema,
  callDeviceSchema,
  callParamsSchema,
  callSchema,
  conversationCallParamsSchema,
  iceConfigSchema,
  joinedCallSchema,
  leaveCallSchema,
  okResponseSchema,
  startCallSchema,
  startedCallSchema,
} from '@tessera/validation';

import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { CallsService } from './calls.js';

export interface CallsModuleDeps {
  readonly calls: CallsService;
}

const policy = (
  name: string,
  limit: number,
  periodMs: number,
  burst: number,
  onStoreFailure: 'open' | 'closed',
): RateLimitPolicy => ({ name: `calls.${name}`, limit, periodMs, burst, onStoreFailure });

const limits = {
  // Ringing someone is the abuse vector (call spam): kept low.
  start: policy('start', 60, 3_600_000, 10, 'closed'),
  join: policy('join', 240, 3_600_000, 30, 'closed'),
  // TURN credentials are relay capacity: limited per user.
  ice: policy('ice', 240, 3_600_000, 30, 'closed'),
  presence: policy('presence', 600, 3_600_000, 60, 'open'),
  read: policy('read', 600, 60_000, 120, 'open'),
} satisfies Record<string, RateLimitPolicy>;

/** The call record is itself the documented record of the event (docs/calling.md §2). */
const callRecord = {
  kind: 'none',
  reason: 'Minimal call record kept in the calls table (docs/calling.md §2); no content',
} as const;
const readOnly = { kind: 'none', reason: 'Read-only' } as const;
const common = { tags: ['calls'], auth: { kind: 'session' }, authorize: ownAccount } as const;

export function callRoutes(deps: CallsModuleDeps): RouteDefinition[] {
  const { calls } = deps;
  return [
    defineRoute({
      ...common,
      id: 'calls.capabilities',
      method: 'GET',
      url: '/api/v1/calls/capabilities',
      summary: 'Whether TURN relaying and group calls are available',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { response: callCapabilitiesSchema },
      successStatus: 200,
      handler: (_request, context) => calls.capabilities(context.session.userId),
    }),
    defineRoute({
      ...common,
      id: 'calls.ice',
      method: 'POST',
      url: '/api/v1/calls/ice',
      summary: 'Fresh short-lived TURN credentials (for an ICE restart)',
      rateLimit: limits.ice,
      audit: { kind: 'none', reason: 'Stateless HMAC credentials that expire in minutes' },
      schema: { body: z.strictObject({}), response: iceConfigSchema },
      successStatus: 200,
      handler: () => Promise.resolve(calls.ice()),
    }),
    defineRoute({
      ...common,
      id: 'calls.start',
      method: 'POST',
      url: '/api/v1/calls',
      summary: 'Start a call in a conversation (or get the one already going on)',
      rateLimit: limits.start,
      audit: callRecord,
      schema: { body: startCallSchema, response: startedCallSchema },
      successStatus: 200,
      handler: ({ body }, context) => calls.start(context.session.userId, body),
    }),
    defineRoute({
      ...common,
      id: 'calls.get',
      method: 'GET',
      url: '/api/v1/calls/:callId',
      summary: 'A call record',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: callParamsSchema, response: callSchema },
      successStatus: 200,
      handler: ({ params }, context) => calls.get(context.session.userId, params.callId),
    }),
    defineRoute({
      ...common,
      id: 'calls.active',
      method: 'GET',
      url: '/api/v1/conversations/:conversationId/call',
      summary: 'The call going on in a conversation, if any',
      rateLimit: limits.read,
      audit: readOnly,
      schema: { params: conversationCallParamsSchema, response: activeCallSchema },
      successStatus: 200,
      handler: async ({ params }, context) => ({
        call: await calls.active(context.session.userId, params.conversationId),
      }),
    }),
    defineRoute({
      ...common,
      id: 'calls.join',
      method: 'POST',
      url: '/api/v1/calls/:callId/join',
      summary: 'Answer or join a call (group calls: returns an SFU token)',
      rateLimit: limits.join,
      audit: callRecord,
      schema: { params: callParamsSchema, body: callDeviceSchema, response: joinedCallSchema },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        calls.join(context.session.userId, params.callId, body.deviceId),
    }),
    defineRoute({
      ...common,
      id: 'calls.leave',
      method: 'POST',
      url: '/api/v1/calls/:callId/leave',
      summary: 'Hang up, decline or leave a call',
      rateLimit: limits.join,
      audit: callRecord,
      schema: { params: callParamsSchema, body: leaveCallSchema, response: callSchema },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        calls.leave(context.session.userId, params.callId, body.deviceId, body.reason),
    }),
    defineRoute({
      ...common,
      id: 'calls.heartbeat',
      method: 'POST',
      url: '/api/v1/calls/:callId/heartbeat',
      summary: 'Confirm this device is still in the call',
      rateLimit: limits.presence,
      audit: readOnly,
      schema: { params: callParamsSchema, body: callDeviceSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params, body }, context) => {
        await calls.heartbeat(context.session.userId, params.callId, body.deviceId);
        return { ok: true as const };
      },
    }),
  ];
}
