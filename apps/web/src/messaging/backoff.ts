/**
 * Exponential backoff with full jitter (docs/realtime.md §5): a random delay in
 * [0, min(cap, base · 2^attempt)]. Spreads reconnect storms after deploys or outages.
 */
export function backoffDelay(
  attempt: number,
  options: { baseMs: number; capMs: number; random?: () => number },
): number {
  const ceiling = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, attempt));
  const random = options.random ?? jitter;
  return Math.floor(random() * ceiling);
}

/** Uniform [0, 1) from the platform CSPRNG (jitter needs no secrecy, but Math.random is banned). */
function jitter(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] ?? 0) / 0x1_0000_0000;
}
