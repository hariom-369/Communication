import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireEnv } from '../test/integration-env.js';

import {
  RateLimitStoreUnavailableError,
  ValkeyRateLimiter,
  type RateLimitPolicy,
} from './rate-limit.js';
import { createValkey, valkeyHealthCheck } from './valkey.js';

let client: Redis;
beforeAll(async () => {
  client = createValkey(requireEnv('TEST_VALKEY_URL'), 'tessera-it');
  await client.connect();
});
afterAll(async () => {
  await client.quit();
});

const unique = () => `it-${Date.now()}-${process.hrtime.bigint()}`;

describe('ValkeyRateLimiter (real Valkey)', () => {
  it('enforces burst and reports retry-after', async () => {
    const policy: RateLimitPolicy = {
      name: unique(),
      limit: 1,
      periodMs: 60_000,
      burst: 3,
      onStoreFailure: 'closed',
    };
    const limiter = new ValkeyRateLimiter(client);
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await limiter.consume(policy, 'subject'));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
    expect(decisions[3]!.retryAfterMs).toBeGreaterThan(55_000);
    expect(decisions[3]!.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('shares state between limiter instances (i.e. between API pods)', async () => {
    const policy: RateLimitPolicy = {
      name: unique(),
      limit: 1,
      periodMs: 60_000,
      burst: 1,
      onStoreFailure: 'closed',
    };
    expect((await new ValkeyRateLimiter(client).consume(policy, 's')).allowed).toBe(true);
    expect((await new ValkeyRateLimiter(client).consume(policy, 's')).allowed).toBe(false);
  });

  it('stores keys with an expiry so idle subjects do not accumulate', async () => {
    const policy: RateLimitPolicy = {
      name: unique(),
      limit: 10,
      periodMs: 1_000,
      burst: 1,
      onStoreFailure: 'closed',
    };
    await new ValkeyRateLimiter(client, 'rlttl').consume(policy, 's');
    const ttl = await client.pttl(`rlttl:${policy.name}:s`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('signals store unavailability instead of allowing silently', async () => {
    const dead = createValkey('redis://127.0.0.1:1', 'tessera-it-dead');
    const limiter = new ValkeyRateLimiter(dead);
    await expect(
      limiter.consume(
        { name: 'x', limit: 1, periodMs: 1000, burst: 1, onStoreFailure: 'closed' },
        's',
      ),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    dead.disconnect();
  });

  it('health check pings the server', async () => {
    await expect(
      valkeyHealthCheck(client).check(new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});
