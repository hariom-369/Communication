import { TIER_LIMITS } from '@tessera/validation';
import { describe, expect, it } from 'vitest';

import { bytes, countries, describeLimits, money } from './format.js';

describe('billing format', () => {
  it('formats money from minor units', () => {
    expect(money(9900, 'INR')).toMatch(/99/);
    expect(money(299, 'USD')).toMatch(/2\.99/);
  });

  it('describes the free tier in words', () => {
    expect(bytes(200 * 1024 * 1024)).toBe('200 MB');
    expect(bytes(1024 ** 3)).toBe('1 GB');
    expect(describeLimits(TIER_LIMITS.free)[0]).toBe('Files up to 200 MB each');
  });

  it('lists India first, then every other country once', () => {
    const list = countries();
    expect(list[0]?.code).toBe('IN');
    expect(new Set(list.map((c) => c.code)).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(240);
  });
});
