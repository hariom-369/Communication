import { describe, expect, it } from 'vitest';

import { bareDomainsIn } from './domains.js';

describe('bareDomainsIn', () => {
  it('finds bare domains followed by a path, whitespace or the end', () => {
    expect(bareDomainsIn('see evil.example.com/login and shop.test today')).toEqual([
      'evil.example.com',
      'shop.test',
    ]);
    expect(bareDomainsIn('ends with example.org')).toEqual(['example.org']);
    expect(bareDomainsIn('(wrapped.example) no.tld. 1.2 example.c')).toEqual([]);
  });

  it('takes linear time on input that made the single-regex version quadratic', () => {
    for (const hostile of ['a.'.repeat(32_000) + '!', 'ab1.'.repeat(16_000) + '1']) {
      const started = performance.now();
      bareDomainsIn(hostile);
      // The old pattern needed ~4 s for these 64 KiB; linear scanning needs a few ms.
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});
