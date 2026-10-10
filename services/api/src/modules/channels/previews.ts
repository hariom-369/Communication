import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  fetchLinkPreview,
  SafeFetchError,
  type LinkPreview,
} from '../../platform/safe-fetch/index.js';

const HIT_TTL_SECONDS = 3600;
const MISS_TTL_SECONDS = 600;

/**
 * Link previews for channel posts, through the SSRF-hardened fetcher (ADR-046), cached in Valkey
 * by URL digest (also negative results, so a bad URL is not fetched repeatedly).
 */
export class LinkPreviewer {
  readonly #valkey: Redis;
  readonly #prefix: string;
  readonly #fetch: (url: string) => Promise<LinkPreview>;

  #enabled: (() => Promise<boolean>) | null = null;

  constructor(
    valkey: Redis,
    prefix: string,
    fetch: (url: string) => Promise<LinkPreview> = fetchLinkPreview,
  ) {
    this.#valkey = valkey;
    this.#prefix = prefix;
    this.#fetch = fetch;
  }

  /** A preview, or null when the URL is not allowed or the page cannot be previewed. */
  /** Kill switch (feature flag `link_previews`, admin console): off → no previews fetched. */
  useSwitch(enabled: () => Promise<boolean>): void {
    this.#enabled = enabled;
  }

  async preview(url: string): Promise<LinkPreview | null> {
    if (this.#enabled !== null && !(await this.#enabled())) return null;
    const key = `${this.#prefix}:lp:${createHash('sha256').update(url).digest('base64url')}`;
    const cached = await this.#valkey.get(key).catch(() => null);
    if (cached !== null) return cached === '' ? null : (JSON.parse(cached) as LinkPreview);
    let result: LinkPreview | null;
    try {
      result = await this.#fetch(url);
    } catch (error) {
      if (!(error instanceof SafeFetchError)) throw error;
      result = null;
    }
    await this.#valkey
      .set(
        key,
        result === null ? '' : JSON.stringify(result),
        'EX',
        result === null ? MISS_TTL_SECONDS : HIT_TTL_SECONDS,
      )
      .catch(() => undefined);
    return result;
  }
}
