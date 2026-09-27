import { describe, expect, it } from 'vitest';

import { idSchema, problemDetailsSchema, problemType } from './index.js';

describe('idSchema', () => {
  it('accepts UUIDv7 and rejects other strings', () => {
    expect(idSchema.safeParse('0190b5a0-7a1c-7cc3-9f6b-2d1e5c4a3b21').success).toBe(true);
    expect(idSchema.safeParse('3b241101-e2bb-4255-8caf-4136c566a962').success).toBe(false);
    expect(idSchema.safeParse(42).success).toBe(false);
  });
});

describe('problem details', () => {
  it('builds stable URN types', () => {
    expect(problemType('RATE_LIMITED')).toBe('urn:tessera:problem:rate-limited');
  });

  it('rejects unknown codes and non-error statuses', () => {
    const base = { type: 't', title: 'x', code: 'NOT_FOUND', status: 404 };
    expect(problemDetailsSchema.safeParse(base).success).toBe(true);
    expect(problemDetailsSchema.safeParse({ ...base, code: 'NOPE' }).success).toBe(false);
    expect(problemDetailsSchema.safeParse({ ...base, status: 200 }).success).toBe(false);
  });
});
