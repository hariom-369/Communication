import { describe, expect, it } from 'vitest';

import { isId, newId } from './id.js';

describe('newId', () => {
  it('produces valid, unique UUIDv7 values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isId(id)).toBe(true);
  });

  it('is time-ordered when generated sequentially', () => {
    const ids = Array.from({ length: 100 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isId', () => {
  it.each([
    ['', false],
    ['not-a-uuid', false],
    ['3b241101-e2bb-4255-8caf-4136c566a962', false], // v4
    ['0190B5A0-7A1C-7CC3-9F6B-2D1E5C4A3B21', false], // upper case is not canonical
    ['0190b5a0-7a1c-7cc3-9f6b-2d1e5c4a3b21', true],
  ])('isId(%j) === %s', (input, expected) => {
    expect(isId(input)).toBe(expected);
  });
});
