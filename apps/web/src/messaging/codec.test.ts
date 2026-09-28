import { describe, expect, it } from 'vitest';

import { createDevPlaintextCodec } from './dev-plaintext-codec.js';
import { backoffDelay } from './backoff.js';

describe('development plaintext codec', () => {
  const codec = createDevPlaintextCodec();

  it('is labelled unprotected and round-trips Unicode content', async () => {
    expect(codec.unprotected).toBe(true);
    expect(codec.ciphersuite).toBe(0);
    const content = {
      v: 1 as const,
      id: 'id-1',
      sentAt: 1,
      body: { kind: 'text' as const, text: 'नमस्ते 👋 <b>hi</b>' },
    };
    expect(await codec.decode(await codec.encode(content))).toEqual(content);
  });

  it('returns null for anything that is not valid content', async () => {
    for (const input of [
      '',
      'not base64!',
      btoa('{"v":2}'),
      btoa('\xff\xfe'),
      btoa('{"v":1,"id":"x","sentAt":1,"body":{"kind":"script"}}'),
    ]) {
      expect(await codec.decode(input)).toBeNull();
    }
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
