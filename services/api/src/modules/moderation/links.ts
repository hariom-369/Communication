import { createHash } from 'node:crypto';

/**
 * Harmful-link checks (docs/moderation.md §4). Hosts are compared by SHA-256; clients look up a
 * 4-byte prefix first and fetch the full hashes for it, so the server never learns which link a
 * person is looking at (k-anonymity, as in Safe Browsing's update API).
 */

export function hostHash(host: string): Buffer {
  return createHash('sha256').update(host).digest();
}

/** Normalised host: lower case, no trailing dot, no "www." prefix. */
export function canonicalHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** The host and each parent domain with at least two labels (a.b.example.com → … example.com). */
export function hostVariants(host: string): string[] {
  const labels = canonicalHost(host)
    .split('.')
    .filter((label) => label !== '');
  const variants: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) variants.push(labels.slice(i).join('.'));
  return variants;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const BARE_DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,63})(?=[/\s]|$)/gi;

/** Hosts mentioned in text, as links or bare domains (example.com/path). */
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
