/**
 * Bare domain names mentioned in text ("see example.com/path"), in linear time.
 *
 * The obvious single regex — `\b((?:[a-z0-9-]+\.)+[a-z]{2,63})(?=[/\s]|$)` with the global flag —
 * is quadratic: it retries the nested quantifier from every word boundary, so 64 KiB of
 * `a.a.a.…` took 4 s of blocked event loop (security review F-12). Here a single-quantifier scan
 * finds runs of domain characters (linear), and each run of at most 253 characters (the longest
 * domain name) is checked against an anchored pattern once.
 */
const RUN = /[a-z0-9.-]+/gi;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i;
const MAX_DOMAIN_LENGTH = 253;

export function bareDomainsIn(text: string): string[] {
  const domains: string[] = [];
  for (const match of text.matchAll(RUN)) {
    // A domain ends the text, or is followed by a path or whitespace.
    const next = text[match.index + match[0].length];
    if (next !== undefined && next !== '/' && !/\s/.test(next)) continue;
    const run = match[0].replace(/^[.-]+/, '');
    if (run.length <= MAX_DOMAIN_LENGTH && DOMAIN.test(run)) domains.push(run);
  }
  return domains;
}
