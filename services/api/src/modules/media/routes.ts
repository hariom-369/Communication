import {
  blobParamsSchema,
  completeUploadSchema,
  createUploadSchema,
  mediaDownloadSchema,
  okResponseSchema,
  uploadCreatedSchema,
  uploadPartsResponseSchema,
  uploadPartsSchema,
} from '@tessera/validation';
import { z } from 'zod';

import { defineRoute, ownAccount, type RouteDefinition } from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { MediaService } from './media.js';

export interface MediaModuleDeps {
  readonly media: MediaService;
}

const limits = {
  create: {
    name: 'media.create',
    limit: 120,
    periodMs: 3_600_000,
    burst: 20,
    onStoreFailure: 'closed',
  },
  upload: {
    name: 'media.upload',
    limit: 600,
    periodMs: 3_600_000,
    burst: 60,
    onStoreFailure: 'open',
  },
  download: {
    name: 'media.download',
    limit: 600,
    periodMs: 3_600_000,
    burst: 60,
    onStoreFailure: 'open',
  },
} satisfies Record<string, RateLimitPolicy>;

const noAudit = {
  kind: 'none',
  reason: 'Ciphertext transfer; sizes and links are recorded in media tables',
} as const;

export function mediaRoutes(deps: MediaModuleDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'media.create_upload',
      method: 'POST',
      url: '/api/v1/media/uploads',
      summary: 'Start uploading an encrypted attachment (returns presigned part URLs)',
      tags: ['media'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.create,
      audit: noAudit,
      schema: { body: createUploadSchema, response: uploadCreatedSchema },
      successStatus: 201,
      handler: ({ body }, context) => deps.media.createUpload(context.session.userId, body.size),
    }),
    defineRoute({
      id: 'media.upload_parts',
      method: 'POST',
      url: '/api/v1/media/uploads/:blobId/parts',
      summary: 'Fresh presigned URLs for parts of an upload in progress',
      tags: ['media'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.upload,
      audit: noAudit,
      schema: {
        params: blobParamsSchema,
        body: uploadPartsSchema,
        response: uploadPartsResponseSchema,
      },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        deps.media.partUrls(context.session.userId, params.blobId, body.partNumbers),
    }),
    defineRoute({
      id: 'media.complete_upload',
      method: 'POST',
      url: '/api/v1/media/uploads/:blobId/complete',
      summary: 'Finish an upload once every part is stored',
      tags: ['media'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.upload,
      audit: noAudit,
      schema: {
        params: blobParamsSchema,
        body: completeUploadSchema,
        response: z.object({ blobId: z.string() }),
      },
      successStatus: 200,
      handler: ({ params, body }, context) =>
        deps.media.completeUpload(context.session.userId, params.blobId, body.parts),
    }),
    defineRoute({
      id: 'media.abort_upload',
      method: 'DELETE',
      url: '/api/v1/media/uploads/:blobId',
      summary: 'Cancel an upload in progress',
      tags: ['media'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.upload,
      audit: noAudit,
      schema: { params: blobParamsSchema, response: okResponseSchema },
      successStatus: 200,
      handler: ({ params }, context) =>
        deps.media.abortUpload(context.session.userId, params.blobId),
    }),
    defineRoute({
      id: 'media.download',
      method: 'GET',
      url: '/api/v1/media/:blobId',
      summary: 'Short-lived URL to download an encrypted attachment',
      tags: ['media'],
      auth: { kind: 'session' },
      authorize: ownAccount,
      rateLimit: limits.download,
      audit: noAudit,
      schema: { params: blobParamsSchema, response: mediaDownloadSchema },
      successStatus: 200,
      handler: ({ params }, context) => deps.media.download(context.session.userId, params.blobId),
    }),
  ];
}
