import { featureFlagsSchema } from '@tessera/validation';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';

import type { FlagsService } from './flags.js';

export interface FlagsModuleDeps {
  readonly flags: FlagsService;
}

export function flagRoutes(deps: FlagsModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'flags.mine',
      method: 'GET',
      url: '/api/v1/features',
      summary: 'Which features are on for you (rollouts and kill switches)',
      tags: ['flags'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: {
        name: 'flags.read',
        limit: 120,
        periodMs: 60_000,
        burst: 30,
        onStoreFailure: 'open',
      },
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: featureFlagsSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        flags: await deps.flags.forUser(context.session.userId),
      }),
    }),
  ];
}
