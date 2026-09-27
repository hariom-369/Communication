import { z } from 'zod';

/**
 * Response of GET /api/v1/meta/version. Clients use `protocol` to decide whether they must reload
 * (docs/deployment.md §3).
 */
export const versionResponseSchema = z.object({
  api: z.literal('v1'),
  build: z.object({
    version: z.string(),
    commit: z.string(),
  }),
  protocol: z.object({
    current: z.number().int().positive(),
    minimumSupported: z.number().int().positive(),
  }),
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;
