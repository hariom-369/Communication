import { z } from 'zod';

import { parsePreviewUrl, SafeFetchError, type FetchFailure, type LinkPreview } from './fetcher.js';

/**
 * Client for the isolated link-preview fetcher (`fetcher-server.ts`, docs/security.md §6,
 * security review F-05). The API process never connects to user-supplied URLs itself in
 * production; it asks the fetcher, which runs in its own deployment with no database, no Valkey,
 * no secrets but its own token, and an egress policy that reaches only public addresses.
 *
 * The fetcher's answer is treated as untrusted: a compromised fetcher must not be able to put
 * anything into a post that the in-process fetcher could not have produced (same URL rules, same
 * length limits).
 */

export const FETCHER_PREVIEW_PATH = '/v1/preview';
const TIMEOUT_MS = 7_000; // the fetcher's own deadline is 5 s

/** The fetcher could not be asked (down, overloaded, misconfigured); not cached as a miss. */
export class FetcherUnavailableError extends Error {
  constructor(reason: string) {
    super(`link-preview fetcher unavailable: ${reason}`);
  }
}

const FAILURES = [
  'invalid_url',
  'blocked_address',
  'dns',
  'too_many_redirects',
  'not_html',
  'too_large',
  'timeout',
  'http_error',
  'network',
] as const satisfies readonly FetchFailure[];

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .nullable();

export const fetcherResponseSchema = z.union([
  z.strictObject({
    preview: z.strictObject({
      url: z.string().max(2048),
      title: text(200),
      description: text(500),
      siteName: text(100),
    }),
  }),
  z.strictObject({ preview: z.null(), reason: z.enum(FAILURES) }),
]);
export type FetcherResponse = z.infer<typeof fetcherResponseSchema>;

export function remoteLinkPreviewFetcher(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): (url: string) => Promise<LinkPreview> {
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}${FETCHER_PREVIEW_PATH}`;
  const doFetch = options.fetch ?? fetch;
  return async (url) => {
    parsePreviewUrl(url); // refuse locally what the fetcher would refuse anyway
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new FetcherUnavailableError('network');
    }
    if (!response.ok) throw new FetcherUnavailableError(`status ${String(response.status)}`);
    let parsed: FetcherResponse;
    try {
      parsed = fetcherResponseSchema.parse(await response.json());
    } catch {
      throw new FetcherUnavailableError('invalid response');
    }
    if (parsed.preview === null) throw new SafeFetchError(parsed.reason);
    const final = parsePreviewUrl(parsed.preview.url);
    return { ...parsed.preview, url: final.href };
  };
}
