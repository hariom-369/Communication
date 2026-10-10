import { entitlementsSchema } from '@tessera/validation';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';

import type { EntitlementsService } from './entitlements.js';

export interface EntitlementsModuleDeps {
  readonly entitlements: EntitlementsService;
}

export function entitlementRoutes(deps: EntitlementsModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'entitlements.mine',
      method: 'GET',
      url: '/api/v1/entitlements',
      summary: 'Your plan tier and its limits',
      tags: ['billing'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: {
        name: 'entitlements.read',
        limit: 120,
        periodMs: 60_000,
        burst: 30,
        onStoreFailure: 'open',
      },
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: entitlementsSchema },
      successStatus: 200,
      handler: (_request, context) => deps.entitlements.forUser(context.session.userId),
    }),
  ];
}
