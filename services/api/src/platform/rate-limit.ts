import type { Redis } from 'ioredis';

/**
 * Rate limiting uses GCRA (generic cell rate algorithm) — an exact, memory-cheap token-bucket
 * equivalent that stores one timestamp per key (docs/security.md §7).
 *
 * For a policy allowing `limit` requests per `periodMs` with bursts of `burst`:
 *   emission interval T = periodMs / limit, tolerance τ = T × (burst − 1).
 * A request at time `now` with stored theoretical arrival time `tat` is allowed iff
 *   max(tat, now) − now ≤ τ, and then tat := max(tat, now) + T.
 */
export interface RateLimitPolicy {
  /** Stable name, used in keys, logs and metrics. */
  readonly name: string;
  readonly limit: number;
  readonly periodMs: number;
  readonly burst: number;
  /**
   * Behaviour when the shared store is unavailable. `closed` rejects (use for authentication and
   * other abuse-sensitive routes); `open` falls back to a per-process limiter.
   */
  readonly onStoreFailure: 'closed' | 'open';
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Milliseconds until the next request would be allowed (0 when allowed). */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision>;
}

export class RateLimitStoreUnavailableError extends Error {
  readonly safeToLog = true as const;

  constructor(options?: { cause?: unknown }) {
    super('Rate limit store unavailable', options);
    this.name = 'RateLimitStoreUnavailableError';
  }
}

/**
 * Subject key for per-client limits. IPv6 clients are limited per /64, the smallest block an
 * end user is typically assigned, so rotating addresses within a subnet does not bypass limits.
 */
export function rateLimitSubject(ip: string): string {
  if (!ip.includes(':')) return `ip:${ip}`;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined) return `ip:${mapped[1]}`;
  return `ip6:${expandIpv6(ip).slice(0, 4).join(':')}::/64`;
}

function expandIpv6(ip: string): string[] {
  const [address = ''] = ip.toLowerCase().split('%'); // drop any zone index
  const [head = '', tail] = address.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array<string>(Math.max(0, missing)).fill('0'), ...tailParts];
  return parts.map((part) => part.replace(/^0+(?=.)/, ''));
}

function parameters(policy: RateLimitPolicy): { interval: number; tolerance: number } {
  const interval = policy.periodMs / policy.limit;
  return { interval, tolerance: interval * (policy.burst - 1) };
}

/** Pure GCRA step. Exported for the in-process limiter and for tests. */
export function gcra(
  policy: RateLimitPolicy,
  storedTat: number | undefined,
  now: number,
): { decision: RateLimitDecision; newTat: number | undefined } {
  const { interval, tolerance } = parameters(policy);
  const tat = Math.max(storedTat ?? now, now);
  if (tat - now > tolerance) {
    return {
      decision: { allowed: false, remaining: 0, retryAfterMs: Math.ceil(tat - tolerance - now) },
      newTat: undefined,
    };
  }
  const newTat = tat + interval;
  const remaining = Math.max(0, Math.floor((now + tolerance + interval - newTat) / interval));
  return { decision: { allowed: true, remaining, retryAfterMs: 0 }, newTat };
}

/**
 * Same algorithm, executed atomically inside Valkey using the server clock so that all API pods
 * share one consistent view regardless of their local clocks.
 */
const GCRA_SCRIPT = `
local interval = tonumber(ARGV[1])
local tolerance = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local stored = redis.call('GET', KEYS[1])
local tat = now
if stored then tat = math.max(tonumber(stored), now) end
if tat - now > tolerance then
  return {0, 0, math.ceil(tat - tolerance - now)}
end
local new_tat = tat + interval
redis.call('SET', KEYS[1], tostring(new_tat), 'PX', math.ceil(new_tat - now))
local remaining = math.floor((now + tolerance + interval - new_tat) / interval)
if remaining < 0 then remaining = 0 end
return {1, remaining, 0}
`;

export class ValkeyRateLimiter implements RateLimiter {
  readonly #client: Redis;
  readonly #keyPrefix: string;

  constructor(client: Redis, keyPrefix = 'rl') {
    this.#client = client;
    this.#keyPrefix = keyPrefix;
  }

  async consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision> {
    const { interval, tolerance } = parameters(policy);
    let reply: unknown;
    try {
      reply = await this.#client.eval(
        GCRA_SCRIPT,
        1,
        `${this.#keyPrefix}:${policy.name}:${subject}`,
        interval,
        tolerance,
      );
    } catch (error) {
      throw new RateLimitStoreUnavailableError({ cause: error });
    }
    if (
      !Array.isArray(reply) ||
      reply.length !== 3 ||
      !reply.every((value): value is number => typeof value === 'number')
    ) {
      throw new RateLimitStoreUnavailableError();
    }
    const [allowed, remaining, retryAfterMs] = reply as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}

/**
 * Per-process GCRA limiter with a bounded key space. Used as the degraded-mode fallback for
 * `open` policies and in unit tests. Not a substitute for the shared limiter: limits apply per
 * process, so the effective limit is multiplied by the number of pods.
 */
export class InProcessRateLimiter implements RateLimiter {
  readonly #tats = new Map<string, number>();
  readonly #maxKeys: number;
  readonly #clock: () => number;

  constructor(options: { maxKeys?: number; clock?: () => number } = {}) {
    this.#maxKeys = options.maxKeys ?? 50_000;
    this.#clock = options.clock ?? Date.now;
  }

  consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision> {
    const key = `${policy.name}:${subject}`;
    const now = this.#clock();
    const { decision, newTat } = gcra(policy, this.#tats.get(key), now);
    if (newTat !== undefined) {
      this.#tats.delete(key); // re-insert to keep Map order ≈ least recently used first
      this.#tats.set(key, newTat);
      this.#evict(now);
    }
    return Promise.resolve(decision);
  }

  #evict(now: number): void {
    for (const [key, tat] of this.#tats) {
      if (this.#tats.size <= this.#maxKeys && tat > now) break;
      if (this.#tats.size > this.#maxKeys || tat <= now) this.#tats.delete(key);
    }
  }
}

/**
 * Shared limiter with the degraded-mode policy from docs/architecture.md §10: when Valkey is
 * unreachable, `closed` policies reject and `open` policies use the per-process limiter.
 */
export class ResilientRateLimiter implements RateLimiter {
  readonly #primary: RateLimiter;
  readonly #fallback: RateLimiter;
  readonly #onStoreFailure: (error: unknown) => void;

  constructor(
    primary: RateLimiter,
    fallback: RateLimiter,
    onStoreFailure: (error: unknown) => void,
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
    this.#onStoreFailure = onStoreFailure;
  }

  async consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision> {
    try {
      return await this.#primary.consume(policy, subject);
    } catch (error) {
      if (!(error instanceof RateLimitStoreUnavailableError)) throw error;
      this.#onStoreFailure(error);
      if (policy.onStoreFailure === 'closed') throw error;
      return this.#fallback.consume(policy, subject);
    }
  }
}
