import { describe, expect, it } from 'vitest';

import { backoffDelay } from './backoff.js';
import { contentSchema } from './content.js';

describe('message content', () => {
  it('accepts the supported kinds and rejects anything else', () => {
    const base = { v: 1, id: 'id-1', sentAt: 1 };
    expect(
      contentSchema.safeParse({ ...base, body: { kind: 'text', text: 'नमस्ते 👋 <b>hi</b>' } })
        .success,
    ).toBe(true);
    for (const body of [
      { kind: 'script' },
      { kind: 'text', text: '' },
      { kind: 'reaction', target: 'x', emoji: 'way too long for an emoji' },
    ]) {
      expect(contentSchema.safeParse({ ...base, body }).success, JSON.stringify(body)).toBe(false);
    }
    expect(
      contentSchema.safeParse({ ...base, v: 2, body: { kind: 'text', text: 'x' } }).success,
    ).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially up to the cap with full jitter', () => {
    const max = (attempt: number) =>
      backoffDelay(attempt, { baseMs: 500, capMs: 30_000, random: () => 0.999999 });
    expect(max(0)).toBe(499);
    expect(max(3)).toBe(3999);
    expect(max(20)).toBe(29_999);
    expect(backoffDelay(5, { baseMs: 500, capMs: 30_000, random: () => 0 })).toBe(0);
    const real = backoffDelay(4, { baseMs: 500, capMs: 30_000 });
    expect(real).toBeGreaterThanOrEqual(0);
    expect(real).toBeLessThan(8000);
  });
});
