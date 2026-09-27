import { versionResponseSchema } from '@tessera/validation';

import { defineRoute, publicAccess, type RouteDefinition } from '../../platform/http/routes.js';

/**
 * Client/server protocol version. Clients below `MINIMUM_SUPPORTED_PROTOCOL` must reload
 * (docs/deployment.md §3). Bump `CURRENT_PROTOCOL` whenever the wire contract changes.
 */
export const CURRENT_PROTOCOL = 1;
export const MINIMUM_SUPPORTED_PROTOCOL = 1;

export interface MetaModuleDeps {
  readonly build: { readonly version: string; readonly commit: string };
}

export function metaRoutes(deps: MetaModuleDeps): RouteDefinition[] {
  const version = defineRoute({
    id: 'meta.version',
    method: 'GET',
    url: '/api/v1/meta/version',
    summary: 'API, build and protocol version',
    tags: ['meta'],
    auth: { kind: 'public' },
    authorize: publicAccess,
    rateLimit: {
      name: 'meta.version',
      limit: 60,
      periodMs: 60_000,
      burst: 20,
      onStoreFailure: 'open',
    },
    audit: { kind: 'none', reason: 'Read-only, non-personal data' },
    schema: { response: versionResponseSchema },
    successStatus: 200,
    handler: () =>
      Promise.resolve({
        api: 'v1' as const,
        build: { version: deps.build.version, commit: deps.build.commit },
        protocol: { current: CURRENT_PROTOCOL, minimumSupported: MINIMUM_SUPPORTED_PROTOCOL },
      }),
  });
  return [version];
}
