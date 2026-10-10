import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { pinnedAddress, SafeFetchError } from './fetcher.js';

/**
 * SSRF-hardened POST for deliveries to third-party services whose URL a user supplied (Web Push
 * endpoints, docs/notifications.md §5). Same address rules as the link-preview fetcher
 * (docs/security.md §6) plus a host allow-list:
 * - `https` on port 443 only, no credentials in the URL, host on the caller's allow-list;
 * - DNS resolved here, every answer checked, connection pinned to a checked address;
 * - no redirects (a 3xx is just a status), 10 s deadline, at most 64 KiB of response read.
 */

export const POST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface SafePostTransport {
  resolve(hostname: string): Promise<string[]>;
  post(
    url: URL,
    address: string,
    headers: Record<string, string>,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<number>;
}

export const defaultPostTransport: SafePostTransport = {
  async resolve(hostname) {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  },
  post(url, address, headers, body, signal) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: address,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: { ...headers, Host: url.host },
          ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
          agent: false,
          signal,
        },
        (response) => {
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) response.destroy();
          });
          const settle = () => {
            resolve(response.statusCode ?? 0);
          };
          response.on('end', settle);
          response.on('close', settle);
          response.on('error', settle);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  },
};

/** True if `hostname` is one of `allowed` or a subdomain of one. */
export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Checks a user-supplied delivery URL against the rules above (no network). */
export function parseDeliveryUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    !hostAllowed(url.hostname, allowedHosts)
  )
    throw new SafeFetchError('invalid_url');
  return url;
}

/** POSTs `body`; resolves with the HTTP status. Throws SafeFetchError for refused targets. */
export async function safePost(
  raw: string,
  allowedHosts: readonly string[],
  headers: Record<string, string>,
  body: Buffer,
  transport: SafePostTransport = defaultPostTransport,
): Promise<number> {
  const url = parseDeliveryUrl(raw, allowedHosts);
  const address = await pinnedAddress(url, {
    resolve: (host) => transport.resolve(host),
    get: () => Promise.reject(new Error('unused')),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, POST_TIMEOUT_MS);
  try {
    return await transport.post(url, address, headers, body, controller.signal);
  } catch {
    throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}
