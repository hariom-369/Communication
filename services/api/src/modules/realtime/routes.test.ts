import { describe, expect, it } from 'vitest';

import { admissionRetryAfterSeconds } from './routes.js';

describe('ticket admission retry delay', () => {
  it('spreads refused clients over 1–10 seconds', () => {
    expect(admissionRetryAfterSeconds(() => 0)).toBe(1);
    expect(admissionRetryAfterSeconds(() => 0.55)).toBe(6);
    expect(admissionRetryAfterSeconds(() => 0.999_999)).toBe(10);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) seen.add(admissionRetryAfterSeconds());
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
