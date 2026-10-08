import { ALL_CHANNEL_PERMISSIONS, CHANNEL_PERMISSIONS } from '@tessera/validation';
import { describe, expect, it } from 'vitest';

import { canChannel, CHANNEL_PERMISSION_KEYS, subscriberLabel } from './shared.js';

describe('channel helpers', () => {
  it('rounds subscriber counts and pluralises', () => {
    expect(subscriberLabel(1)).toBe('1 subscriber');
    expect(subscriberLabel(950)).toBe('950 subscribers');
    expect(subscriberLabel(12_400)).toMatch(/^12\.4K subscribers$/);
    expect(subscriberLabel(1_000_000)).toMatch(/^1M subscribers$/);
  });

  it('checks permission bits, and labels every one', () => {
    expect(canChannel(CHANNEL_PERMISSIONS.post, 'post')).toBe(true);
    expect(canChannel(CHANNEL_PERMISSIONS.post, 'deleteAny')).toBe(false);
    expect(CHANNEL_PERMISSION_KEYS.every((key) => canChannel(ALL_CHANNEL_PERMISSIONS, key))).toBe(
      true,
    );
    expect(CHANNEL_PERMISSION_KEYS).toHaveLength(Object.keys(CHANNEL_PERMISSIONS).length);
  });
});
