import { describe, expect, it, vi } from 'vitest';

import {
  gcra,
  InProcessRateLimiter,
  rateLimitSubject,
  RateLimitStoreUnavailableError,
  ResilientRateLimiter,
  type RateLimiter,
  type RateLimitPolicy,
} from './rate-limit.js';

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: 'p',
  limit: 10,
  periodMs: 10_000, // one token per second
  burst: 3,
  onStoreFailure: 'open',
  ...overrides,
});

describe('gcra', () => {
  it('allows a burst, then one request per emission interval', () => {
    const p = policy();
    let tat: number | undefined;
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const step = gcra(p, tat, 0);
      results.push(step.decision.allowed);
      tat = step.newTat ?? tat;
    }
    expect(results).toEqual([true, true, true, false]);
    expect(gcra(p, tat, 0).decision.retryAfterMs).toBe(1000);
    expect(gcra(p, tat, 999).decision.allowed).toBe(false);
    expect(gcra(p, tat, 1000).decision.allowed).toBe(true);
  });

  it('reports remaining capacity', () => {
    const p = policy();
    const first = gcra(p, undefined, 0);
    expect(first.decision.remaining).toBe(2);
    const second = gcra(p, first.newTat, 0);
    expect(second.decision.remaining).toBe(1);
  });

  it('refills fully after idle time', () => {
    const p = policy();
    const exhausted = 3_000;
    expect(gcra(p, exhausted, 100_000).decision.remaining).toBe(2);
  });
});

describe('InProcessRateLimiter', () => {
  it('isolates subjects and policies', async () => {
    const limiter = new InProcessRateLimiter({ clock: () => 0 });
    const p = policy({ burst: 1 });
    expect((await limiter.consume(p, 'a')).allowed).toBe(true);
    expect((await limiter.consume(p, 'a')).allowed).toBe(false);
    expect((await limiter.consume(p, 'b')).allowed).toBe(true);
    expect((await limiter.consume({ ...p, name: 'other' }, 'a')).allowed).toBe(true);
  });

  it('bounds memory by evicting keys', async () => {
    const limiter = new InProcessRateLimiter({ clock: () => 0, maxKeys: 10 });
    const p = policy({ burst: 1 });
    for (let i = 0; i < 100; i++) await limiter.consume(p, `s${i}`);
    // The oldest subject was evicted and is therefore allowed again.
    expect((await limiter.consume(p, 's0')).allowed).toBe(true);
    expect((await limiter.consume(p, 's99')).allowed).toBe(false);
  });
});

describe('ResilientRateLimiter', () => {
  const broken: RateLimiter = {
    consume: () => Promise.reject(new RateLimitStoreUnavailableError()),
  };

  it('fails closed for closed policies', async () => {
    const onFailure = vi.fn();
    const limiter = new ResilientRateLimiter(broken, new InProcessRateLimiter(), onFailure);
    await expect(limiter.consume(policy({ onStoreFailure: 'closed' }), 's')).rejects.toBeInstanceOf(
      RateLimitStoreUnavailableError,
    );
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('falls back to the in-process limiter for open policies', async () => {
    const limiter = new ResilientRateLimiter(broken, new InProcessRateLimiter(), () => {});
    const p = policy({ burst: 1 });
    expect((await limiter.consume(p, 's')).allowed).toBe(true);
    expect((await limiter.consume(p, 's')).allowed).toBe(false);
  });

  it('does not swallow unrelated errors', async () => {
    const failing: RateLimiter = { consume: () => Promise.reject(new TypeError('bug')) };
    const limiter = new ResilientRateLimiter(failing, new InProcessRateLimiter(), () => {});
    await expect(limiter.consume(policy(), 's')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('rateLimitSubject', () => {
  it.each([
    ['203.0.113.7', 'ip:203.0.113.7'],
    ['::ffff:203.0.113.7', 'ip:203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', 'ip6:2001:db8:abcd:12::/64'],
    ['2001:db8:abcd:12::9', 'ip6:2001:db8:abcd:12::/64'],
    ['2001:0db8:0000:0012::1', 'ip6:2001:db8:0:12::/64'],
    ['::1', 'ip6:0:0:0:0::/64'],
  ])('%s -> %s', (ip, expected) => {
    expect(rateLimitSubject(ip)).toBe(expected);
  });

  it('groups addresses from the same /64', () => {
    expect(rateLimitSubject('2001:db8:1:2:aaaa::1')).toBe(rateLimitSubject('2001:db8:1:2:bbbb::2'));
  });
});
