import {
  claimedKeyPackagesSchema,
  claimKeyPackagesSchema,
  deviceParamsSchema,
  keyPackageCountSchema,
  ownKeysSchema,
  registerDeviceSchema,
  uploadKeyPackagesSchema,
  userKeysSchema,
  userParamsSchema,
} from '@tessera/validation';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { KeysService } from './keys.js';

export interface KeysModuleDeps {
  readonly keys: KeysService;
}

const limits = {
  register: {
    name: 'keys.register',
    limit: 20,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  reset: {
    name: 'keys.reset',
    limit: 5,
    periodMs: 24 * 3_600_000,
    burst: 3,
    onStoreFailure: 'closed',
  },
  read: { name: 'keys.read', limit: 600, periodMs: 60_000, burst: 120, onStoreFailure: 'open' },
  upload: {
    name: 'keys.upload',
    limit: 60,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'open',
  },
  /** Anti-exhaustion (crypto-design §4): per claimer … */
  claim: {
    name: 'keys.claim',
    limit: 50,
    periodMs: 3_600_000,
    burst: 20,
    onStoreFailure: 'closed',
  },
} satisfies Record<string, RateLimitPolicy>;

/** … and per target account. */
const claimTarget: RateLimitPolicy = {
  name: 'keys.claim_target',
  limit: 500,
  periodMs: 24 * 3_600_000,
  burst: 100,
  onStoreFailure: 'closed',
};

export function keysRoutes(deps: KeysModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'keys.register_device',
      method: 'POST',
      url: '/api/v1/keys/devices',
      summary: "Set up end-to-end encryption on the account's first device",
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.register,
      audit: { kind: 'records', actions: ['keys.identity_created'] },
      schema: { body: registerDeviceSchema, response: ownKeysSchema },
      successStatus: 201,
      bodyLimit: 1024 * 1024,
      handler: ({ body }, context) =>
        deps.keys.registerDevice(context.session.userId, body, {
          reset: false,
          requestId: context.requestId,
        }),
    }),
    defineRoute({
      id: 'keys.reset_identity',
      method: 'POST',
      url: '/api/v1/keys/identity/reset',
      summary: 'Replace the account identity key on this device; revokes all other devices',
      tags: ['keys'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.reset,
      audit: { kind: 'records', actions: ['keys.identity_reset'] },
      schema: { body: registerDeviceSchema, response: ownKeysSchema },
      successStatus: 201,
      bodyLimit: 1024 * 1024,
      handler: ({ body }, context) =>
        deps.keys.registerDevice(context.session.userId, body, {
          reset: true,
          requestId: context.requestId,
        }),
    }),
    defineRoute({
      id: 'keys.own',
      method: 'GET',
      url: '/api/v1/keys/me',
      summary: "The signed-in user's identity key version and active devices",
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: ownKeysSchema },
      successStatus: 200,
      handler: (_input, context) => deps.keys.ownKeys(context.session.userId),
    }),
    defineRoute({
      id: 'keys.user',
      method: 'GET',
      url: '/api/v1/keys/users/:userId',
      summary: "A contact's identity key and device certificates",
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only public key material' },
      schema: { params: userParamsSchema, response: userKeysSchema },
      successStatus: 200,
      handler: ({ params }, context) => deps.keys.userKeys(context.session.userId, params.userId),
    }),
    defineRoute({
      id: 'keys.upload_key_packages',
      method: 'POST',
      url: '/api/v1/keys/devices/:deviceId/key-packages',
      summary:
        "Top up a device's one-time KeyPackages (and optionally replace its last-resort one)",
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.upload,
      audit: { kind: 'none', reason: 'Routine key rotation; public material only' },
      schema: {
        params: deviceParamsSchema,
        body: uploadKeyPackagesSchema,
        response: keyPackageCountSchema,
      },
      successStatus: 200,
      bodyLimit: 1024 * 1024,
      handler: ({ params, body }, context) =>
        deps.keys.uploadKeyPackages(context.session.userId, params.deviceId, body),
    }),
    defineRoute({
      id: 'keys.key_package_count',
      method: 'GET',
      url: '/api/v1/keys/devices/:deviceId/key-packages',
      summary: 'How many one-time KeyPackages a device has left',
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { params: deviceParamsSchema, response: keyPackageCountSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        deps.keys.keyPackageCount(context.session.userId, params.deviceId),
    }),
    defineRoute({
      id: 'keys.claim',
      method: 'POST',
      url: '/api/v1/keys/claim',
      summary:
        'Claim one KeyPackage per active device of a contact (to add them to a conversation)',
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.claim,
      audit: {
        kind: 'none',
        reason: 'Key material traffic is not audited (metadata minimisation)',
      },
      schema: { body: claimKeyPackagesSchema, response: claimedKeyPackagesSchema },
      successStatus: 200,
      handler: async ({ body }, context) => {
        await context.rateLimit(claimTarget, body.userId);
        return deps.keys.claim(context.session.userId, body.userId);
      },
    }),
  ];
}
