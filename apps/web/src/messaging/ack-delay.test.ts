import { describe, expect, it } from 'vitest';

import { ackDelayMs } from './ack-delay.js';

describe('acknowledgement delay', () => {
  it('stays short for direct and small conversations', () => {
    expect(ackDelayMs(2)).toBe(150);
    expect(ackDelayMs(30)).toBe(150);
  });

  it('bounds the acknowledgements a busy group produces, whatever its size', () => {
    for (const members of [64, 256, 1024]) {
      const perSecond = members / (ackDelayMs(members) / 1000);
      expect(perSecond).toBeLessThanOrEqual(250);
    }
    expect(ackDelayMs(1024)).toBe(4096);
    expect(ackDelayMs(100_000)).toBe(5000);
  });
});
