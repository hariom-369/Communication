import { z } from 'zod';

/**
 * Stable machine-readable error codes. Clients switch on `code`; `title`/`detail` are for humans.
 * Adding a code is backwards compatible; renaming or removing one is a breaking API change.
 */
export const problemCodes = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'USERNAME_TAKEN',
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'WEAK_PASSWORD',
  'STEP_UP_REQUIRED',
  'LAST_CREDENTIAL',
  'ACCOUNT_SUSPENDED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ProblemCode = (typeof problemCodes)[number];

/** RFC 9457 problem details, as returned by every API error response. */
export const problemDetailsSchema = z.object({
  type: z.string(),
  code: z.enum(problemCodes),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errorId: z.string().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  fieldErrors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .max(50)
    .optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/** The `type` URI for a problem code. A URN avoids depending on any hosted documentation URL. */
export function problemType(code: ProblemCode): string {
  return `urn:tessera:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
