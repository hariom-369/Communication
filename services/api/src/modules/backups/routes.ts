import {
  addBackupWrapSchema,
  backupDownloadSchema,
  backupStatusSchema,
  backupWrapParamsSchema,
  MAX_BACKUP_BYTES,
  okResponseSchema,
  uploadBackupSchema,
} from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { BackupsService } from './backups.js';

export interface BackupsModuleDeps {
  readonly backups: BackupsService;
}

const limits = {
  read: { name: 'backups.read', limit: 120, periodMs: 60_000, burst: 30, onStoreFailure: 'open' },
  keys: {
    name: 'backups.keys',
    limit: 10,
    periodMs: 3_600_000,
    burst: 5,
    onStoreFailure: 'closed',
  },
  upload: {
    name: 'backups.upload',
    limit: 30,
    periodMs: 3_600_000,
    burst: 10,
    onStoreFailure: 'open',
  },
  download: {
    name: 'backups.download',
    limit: 10,
    periodMs: 3_600_000,
    burst: 5,
    onStoreFailure: 'closed',
  },
} satisfies Record<string, RateLimitPolicy>;

export function backupsRoutes(deps: BackupsModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'backups.status',
      method: 'GET',
      url: '/api/v1/backups',
      summary: 'Latest backup and the ways to unlock backups',
      tags: ['backups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: backupStatusSchema },
      successStatus: 200,
      handler: (_input, context) => deps.backups.status(context.session.userId),
    }),
    defineRoute({
      id: 'backups.add_key',
      method: 'POST',
      url: '/api/v1/backups/keys',
      summary: 'Add a recovery key or passkey that unlocks backups (wrapped key only)',
      tags: ['backups'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.keys,
      audit: { kind: 'records', actions: ['backups.key_added'] },
      schema: { body: addBackupWrapSchema, response: z.object({ id: z.string() }) },
      successStatus: 201,
      handler: ({ body }, context) =>
        deps.backups.addWrap(context.session.userId, body, context.requestId),
    }),
    defineRoute({
      id: 'backups.remove_key',
      method: 'DELETE',
      url: '/api/v1/backups/keys/:id',
      summary: 'Remove a way to unlock backups',
      tags: ['backups'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.keys,
      audit: { kind: 'records', actions: ['backups.key_removed'] },
      schema: { params: backupWrapParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: async ({ params }, context) => {
        await deps.backups.deleteWrap(context.session.userId, params.id, context.requestId);
        return { ok: true as const };
      },
    }),
    defineRoute({
      id: 'backups.upload',
      method: 'POST',
      url: '/api/v1/backups/versions',
      summary: 'Store the next encrypted backup version',
      tags: ['backups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.upload,
      audit: { kind: 'none', reason: 'Routine encrypted backup; key changes are audited' },
      schema: { body: uploadBackupSchema, response: z.object({ version: z.number() }) },
      successStatus: 201,
      bodyLimit: Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 64 * 1024,
      handler: ({ body }, context) => deps.backups.upload(context.session.userId, body),
    }),
    defineRoute({
      id: 'backups.latest',
      method: 'GET',
      url: '/api/v1/backups/latest',
      summary: 'Download the latest encrypted backup and wrapped keys (for restoring)',
      tags: ['backups'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.download,
      audit: { kind: 'none', reason: 'Encrypted data only; the server cannot open it' },
      schema: { response: backupDownloadSchema },
      successStatus: 200,
      handler: (_input, context) => deps.backups.latest(context.session.userId),
    }),
    defineRoute({
      id: 'backups.disable',
      method: 'DELETE',
      url: '/api/v1/backups',
      summary: 'Turn backups off and delete them',
      tags: ['backups'],
      auth: { kind: 'session', stepUp: true },
      authorize: ownAccount,
      rateLimit: limits.keys,
      audit: { kind: 'records', actions: ['backups.disabled'] },
      schema: { response: okResponseSchema },
      successStatus: 200,
      handler: async (_input, context) => {
        await deps.backups.disable(context.session.userId, context.requestId);
        return { ok: true as const };
      },
    }),
  ];
}
