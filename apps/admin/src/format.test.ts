import { describe, expect, it } from 'vitest';

import { purposeText, roleName, until } from './format.js';

describe('format', () => {
  it('names roles', () => {
    expect(roleName('security_admin')).toBe('Security admin');
    expect(roleName('unknown_role')).toBe('unknown_role');
  });

  it('describes how long a role lasts', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(until('2026-01-01T00:30:00Z', now)).toBe('in 30 min');
    expect(until('2026-01-01T03:20:00Z', now)).toBe('in 3 h 20 min');
    expect(until('2026-01-31T00:00:00Z', now)).toBe('in 30 days');
    expect(until('2025-12-31T23:00:00Z', now)).toBe('expired');
  });

  it('builds purposes the API accepts', () => {
    expect(purposeText('ticket', ' 0190b6a4-0000-7000-8000-000000000000 ')).toBe(
      'ticket:0190b6a4-0000-7000-8000-000000000000',
    );
    expect(purposeText('investigation', 'credential stuffing')).toBe(
      'investigation:credential stuffing',
    );
  });
});
