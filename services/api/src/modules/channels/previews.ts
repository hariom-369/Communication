import { createHash } from 'node:crypto';

import type { Logger } from '@tessera/platform';
import type { Redis } from 'ioredis';

import {
  fetchLinkPreview,
  SafeFetchError,
  type LinkPreview,
} from '../../platform/safe-fetch/index.js';
import { FetcherUnavailableError } from '../../platform/safe-fetch/remote.js';

const HIT_TTL_SECONDS = 3600;
const MISS_TTL_SECONDS = 600;

export type PreviewResult = 'fetched' | 'refused' | 'cached' | 'unavailable';

/**
 * Link previews for channel posts, through the SSRF-hardened fetcher (ADR-046) — in production
 * the isolated fetcher service (F-05) — cached in Valkey by URL digest (also negative results, so
 * a bad URL is not fetched repeatedly). A fetcher outage is not cached: the post is published
 * without a preview and the next post with that link tries again.
 */
export class LinkPreviewer {
  readonly #valkey: Redis;
  readonly #prefix: string;
  readonly #fetch: (url: string) => Promise<LinkPreview>;
  readonly #logger: Logger | undefined;
  readonly #onResult: (result: PreviewResult) => void;

  #enabled: (() => Promise<boolean>) | null = null;

  constructor(
    valkey: Redis,
    prefix: string,
    fetch: ((url: string) => Promise<LinkPreview>) | undefined = fetchLinkPreview,
    options: { logger?: Logger; onResult?: (result: PreviewResult) => void } = {},
  ) {
    this.#valkey = valkey;
    this.#prefix = prefix;
    this.#fetch = fetch;
    this.#logger = options.logger;
    this.#onResult = options.onResult ?? (() => undefined);
  }

  /** Kill switch (feature flag `link_previews`, admin console): off → no previews fetched. */
  useSwitch(enabled: () => Promise<boolean>): void {
    this.#enabled = enabled;
  }

  /** A preview, or null when the URL is not allowed or the page cannot be previewed. */
  async preview(url: string): Promise<LinkPreview | null> {
    if (this.#enabled !== null && !(await this.#enabled())) return null;
    const key = `${this.#prefix}:lp:${createHash('sha256').update(url).digest('base64url')}`;
    const cached = await this.#valkey.get(key).catch(() => null);
    if (cached !== null) {
      this.#onResult('cached');
      return cached === '' ? null : (JSON.parse(cached) as LinkPreview);
    }
    let result: LinkPreview | null;
    try {
      result = await this.#fetch(url);
      this.#onResult('fetched');
    } catch (error) {
      if (error instanceof FetcherUnavailableError) {
        this.#onResult('unavailable');
        this.#logger?.warn('channels.link_preview_unavailable', this.#logger.errorFields(error));
        return null;
      }
      if (!(error instanceof SafeFetchError)) throw error;
      this.#onResult('refused');
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
