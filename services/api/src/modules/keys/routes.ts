import {
  addDeviceSchema,
  approveLinkSchema,
  createLinkSchema,
  linkCreatedSchema,
  linkLookupParamsSchema,
  linkParamsSchema,
  linkRequestSchema,
  linkStatusSchema,
  okResponseSchema,
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
  /**
   * Anti-exhaustion (crypto-design §4): per claimer … Creating a group claims one package per
   * person added, so the burst covers a 100-person group at once (larger groups complete as the
   * client retries); the per-target limit below is what protects any one account.
   */
  claim: {
    name: 'keys.claim',
    limit: 300,
    periodMs: 3_600_000,
    burst: 100,
    onStoreFailure: 'closed',
  },
} satisfies Record<string, RateLimitPolicy>;

const linkLimits = {
  create: {
    name: 'keys.link_create',
    limit: 20,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  /** Guessing short link ids is bounded here (and they are scoped to the account). */
  lookup: {
    name: 'keys.link_lookup',
    limit: 30,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'closed',
  },
  approve: {
    name: 'keys.link_approve',
    limit: 10,
    periodMs: 3_600_000,
    burst: 5,
    onStoreFailure: 'closed',
  },
  poll: { name: 'keys.link_poll', limit: 240, periodMs: 60_000, burst: 60, onStoreFailure: 'open' },
  devices: {
    name: 'keys.devices',
    limit: 20,
    periodMs: 3_600_000,
    burst: 10,
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
      id: 'keys.add_device',
      method: 'POST',
      url: '/api/v1/keys/devices/linked',
      summary: 'Add a device to the current identity (linked, or restored from a backup)',
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: linkLimits.devices,
      audit: { kind: 'records', actions: ['keys.device_added'] },
      schema: { body: addDeviceSchema, response: ownKeysSchema },
      successStatus: 201,
      bodyLimit: 1024 * 1024,
      handler: ({ body }, context) =>
        deps.keys.addDevice(context.session.userId, body, context.requestId),
    }),
    defineRoute({
      id: 'keys.revoke_device',
      method: 'DELETE',
      url: '/api/v1/keys/devices/:deviceId',
      summary: 'Remove a device from encrypted chats',
      tags: ['keys'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: linkLimits.devices,
      audit: { kind: 'records', actions: ['keys.device_revoked'] },
      schema: { params: deviceParamsSchema, response: ownKeysSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        deps.keys.revokeDevice(context.session.userId, params.deviceId, context.requestId),
    }),
    defineRoute({
      id: 'keys.create_link',
      method: 'POST',
      url: '/api/v1/keys/links',
      summary: 'A new device asks to be linked (publishes its link keys)',
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: linkLimits.create,
      audit: { kind: 'none', reason: 'No change until an existing device approves' },
      schema: { body: createLinkSchema, response: linkCreatedSchema },
      successStatus: 201,
      handler: ({ body }, context) =>
        deps.keys.createLink(context.session.userId, context.session.id, body),
    }),
    defineRoute({
      id: 'keys.lookup_link',
      method: 'GET',
      url: '/api/v1/keys/links/by-code/:shortId',
      summary: 'An existing device looks up a link request from the code',
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: linkLimits.lookup,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { params: linkLookupParamsSchema, response: linkRequestSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        deps.keys.lookupLink(context.session.userId, params.shortId),
    }),
    defineRoute({
      id: 'keys.approve_link',
      method: 'POST',
      url: '/api/v1/keys/links/:linkId/approve',
      summary: 'An existing device approves a link (relays the sealed payload)',
      tags: ['keys'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: linkLimits.approve,
      audit: { kind: 'none', reason: 'Recorded when the new device registers (keys.device_added)' },
      schema: { params: linkParamsSchema, body: approveLinkSchema, response: okResponseSchema },
      successStatus: 200,
      bodyLimit: 12 * 1024 * 1024,
      handler: async ({ params, body }, context) => {
        await deps.keys.approveLink(context.session.userId, params.linkId, body);
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'keys.link_status',
      method: 'GET',
      url: '/api/v1/keys/links/:linkId',
      summary: 'The waiting device checks for (and receives once) the approval',
      tags: ['keys'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: linkLimits.poll,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { params: linkParamsSchema, response: linkStatusSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        deps.keys.linkStatus(context.session.userId, context.session.id, params.linkId),
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
