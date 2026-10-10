import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';

import { isPublicAddress } from './address-policy.js';
import { parseHeadMetadata, type PageMetadata } from './head-metadata.js';

/**
 * SSRF-hardened fetcher for link previews (docs/security.md §6, ADR-046). It is the only code
 * that fetches user-supplied URLs.
 *
 * - `https` on port 443 only; no credentials in the URL; no cookies sent or kept;
 * - DNS resolved here, *every* address checked against the deny-list, and the connection pinned
 *   to a checked address (no second lookup an attacker could rebind); TLS still verifies the
 *   certificate for the hostname;
 * - redirects followed manually, at most 3, each one re-validated from scratch;
 * - 5 s overall deadline, 2 MiB cap (stopping as soon as `</head>` is seen), identity encoding
 *   only (no decompression bombs), HTML only, fixed User-Agent.
 */

export const USER_AGENT = 'TesseraLinkPreview/1.0';
export const MAX_REDIRECTS = 3;
export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 5000;

export type FetchFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns'
  | 'too_many_redirects'
  | 'not_html'
  | 'too_large'
  | 'timeout'
  | 'http_error'
  | 'network';

export class SafeFetchError extends Error {
  readonly reason: FetchFailure;
  constructor(reason: FetchFailure) {
    super(`link preview refused: ${reason}`);
    this.reason = reason;
  }
}

export interface LinkPreview extends PageMetadata {
  /** Final URL after redirects. */
  readonly url: string;
}

/** Transport, replaceable in tests. `address` is the validated IP to connect to. */
export interface SafeFetchTransport {
  resolve(hostname: string): Promise<string[]>;
  get(
    url: URL,
    address: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<IncomingMessage>;
}

export const defaultTransport: SafeFetchTransport = {
  async resolve(hostname) {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  },
  get(url, address, headers, signal) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: address,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers,
          // Certificate checked against the hostname, while connecting to the pinned address.
          ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
          agent: false,
          signal,
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
  },
};

/** Normalises and checks a user-supplied URL (no network). */
export function parsePreviewUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeFetchError('invalid_url');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === '' ||
    url.hostname.length > 253 ||
    url.href.length > 2048
  )
    throw new SafeFetchError('invalid_url');
  url.hash = '';
  return url;
}

export async function pinnedAddress(url: URL, transport: SafeFetchTransport): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await transport.resolve(host);
    } catch {
      throw new SafeFetchError('dns');
    }
  }
  // Any non-public answer refuses the whole name (mixed answers are a rebinding trick).
  const [first] = addresses;
  if (first === undefined || !addresses.every(isPublicAddress))
    throw new SafeFetchError('blocked_address');
  return first;
}

async function readHead(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BYTES) {
      response.destroy();
      throw new SafeFetchError('too_large');
    }
    chunks.push(buffer);
    if (/<\/head\s*>|<body[\s>]/i.test(buffer.toString('latin1'))) {
      response.destroy();
      break;
    }
  }
  const charset = /charset=([\w-]+)/i.exec(response.headers['content-type'] ?? '')?.[1];
  const body = Buffer.concat(chunks);
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body); // unknown charset label
  }
}

export async function fetchLinkPreview(
  raw: string,
  transport: SafeFetchTransport = defaultTransport,
): Promise<LinkPreview> {
  let url = parsePreviewUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop += 1) {
      const address = await pinnedAddress(url, transport);
      let response: IncomingMessage;
      try {
        response = await transport.get(
          url,
          address,
          {
            host: url.host,
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml',
            'accept-encoding': 'identity',
          },
          controller.signal,
        );
      } catch {
        throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'network');
      }
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.destroy();
        if (hop >= MAX_REDIRECTS) throw new SafeFetchError('too_many_redirects');
        url = parsePreviewUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new SafeFetchError('http_error');
      }
      const type = (response.headers['content-type'] ?? '').toLowerCase();
      const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml)\b/.test(type) || encoding !== 'identity') {
        response.destroy();
        throw new SafeFetchError('not_html');
      }
      let html: string;
      try {
        html = await readHead(response);
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'network');
      }
      return { url: url.href, ...parseHeadMetadata(html) };
    }
  } finally {
    clearTimeout(timer);
  }
}
