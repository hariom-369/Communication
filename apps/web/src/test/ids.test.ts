import { isId } from '@tessera/shared';
import { describe, expect, it } from 'vitest';

import { testId } from './ids.js';

describe('testId', () => {
  it('gives the same valid UUIDv7 for a label, and different ones for different labels', () => {
    expect(isId(testId('peer'))).toBe(true);
    expect(testId('peer')).toBe(testId('peer'));
    expect(new Set(['me', 'peer', 'm1', 'm2', 'peer-device'].map(testId)).size).toBe(5);
  });
});
