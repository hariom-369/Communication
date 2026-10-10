import { useEffect, useState } from 'react';

import { moderationEndpoints } from '../api/moderation-endpoints.js';

/**
 * Harmful-link warnings in end-to-end encrypted chats (docs/moderation.md §4). The server cannot
 * read messages, so the check runs on the device: it downloads short (4-byte) SHA-256 prefixes
 * of blocklisted hosts, and only for a matching prefix asks for the full hashes of that prefix.
 * The server learns at most a prefix shared by many hosts, never the link (k-anonymity).
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const BARE_DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,63})(?=[/\s]|$)/gi;
const REFRESH_MS = 30 * 60_000;

function canonicalHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** Hosts mentioned in text, as links or bare domains (same rules as the server). */
export function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      hosts.add(canonicalHost(new URL(match[0]).hostname));
    } catch {
      // Not a URL after all.
    }
  }
  for (const match of text.matchAll(BARE_DOMAIN)) {
    const host = match[1];
    if (host !== undefined) hosts.add(canonicalHost(host));
  }
  return [...hosts];
}

/** The host and each parent domain with at least two labels. */
export function hostVariants(host: string): string[] {
  const labels = canonicalHost(host)
    .split('.')
    .filter((label) => label !== '');
  const variants: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) variants.push(labels.slice(i).join('.'));
  return variants;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export interface LinkSafetyApi {
  linkPrefixes(): Promise<{ prefixes: string }>;
  linkHashes(prefix: string): Promise<{ hashes: { sha256: string; category: string }[] }>;
}

export class LinkSafety {
  readonly #api: LinkSafetyApi;
  #prefixes: Promise<Set<string>> | null = null;
  #loadedAt = 0;
  readonly #hashes = new Map<string, Promise<Map<string, string>>>();

  constructor(api: LinkSafetyApi) {
    this.#api = api;
  }

  #prefixSet(): Promise<Set<string>> {
    if (this.#prefixes === null || Date.now() - this.#loadedAt > REFRESH_MS) {
      this.#loadedAt = Date.now();
      this.#hashes.clear();
      this.#prefixes = this.#api.linkPrefixes().then(({ prefixes }) => {
        const bytes = Uint8Array.from(atob(prefixes), (char) => char.charCodeAt(0));
        const set = new Set<string>();
        for (let i = 0; i + 4 <= bytes.length; i += 4) set.add(hex(bytes.subarray(i, i + 4)));
        return set;
      });
      // A failed download is retried on the next check, not cached.
      this.#prefixes.catch(() => {
        this.#prefixes = null;
      });
    }
    return this.#prefixes;
  }

  #full(prefix: string): Promise<Map<string, string>> {
    let found = this.#hashes.get(prefix);
    if (found === undefined) {
      found = this.#api
        .linkHashes(prefix)
        .then(({ hashes }) => new Map(hashes.map((h) => [h.sha256, h.category])));
      this.#hashes.set(prefix, found);
    }
    return found;
  }

  /** Hosts in `text` on the blocklist (as written in the text). Empty when unsure. */
  async harmfulHosts(text: string): Promise<string[]> {
    const hosts = hostsIn(text);
    if (hosts.length === 0) return [];
    let prefixes: Set<string>;
    try {
      prefixes = await this.#prefixSet();
    } catch {
      return [];
    }
    const harmful: string[] = [];
    for (const host of hosts) {
      for (const variant of hostVariants(host)) {
        const digest = await sha256Hex(variant);
        const prefix = digest.slice(0, 8);
        if (!prefixes.has(prefix)) continue;
        const full = await this.#full(prefix).catch(() => new Map<string, string>());
        if (full.has(digest)) {
          harmful.push(host);
          break;
        }
      }
    }
    return harmful;
  }
}

const shared = new LinkSafety(moderationEndpoints);

/** Harmful hosts linked in `text` (checked on the device; see LinkSafety). */
export function useHarmfulLinks(text: string, enabled: boolean): string[] {
  const [hosts, setHosts] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || hostsIn(text).length === 0) return;
    let cancelled = false;
    void shared.harmfulHosts(text).then((found) => {
      if (!cancelled) setHosts(found);
    });
    return () => {
      cancelled = true;
    };
  }, [text, enabled]);
  return enabled ? hosts : [];
}
