import { randomBytes } from 'node:crypto';

import { AppError } from '@tessera/platform';
import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';

import { assertStrongPassword, parsePepper, PasswordHasher } from './passwords.js';
import { formatRecoveryCode, generateRecoveryCode, recoveryCodeDigest } from './recovery-codes.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

const pepper = (id: string) => parsePepper(`${id}:${randomBytes(32).toString('base64')}`);

describe('PasswordHasher', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hasher = new PasswordHasher(pepper('p1'));
    const stored = await hasher.hash('a long unusual passphrase');
    expect(stored.hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await hasher.verify('a long unusual passphrase', stored)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect((await hasher.verify('a long unusual passphrasE', stored)).valid).toBe(false);
  });

  it('normalises Unicode (NFKC) so equivalent inputs match', async () => {
    const hasher = new PasswordHasher(pepper('p1'));
    const stored = await hasher.hash('ｐａｓｓｐｈｒａｓｅ with full-width letters');
    expect((await hasher.verify('passphrase with full-width letters', stored)).valid).toBe(true);
  });

  it('depends on the pepper and supports pepper rotation with rehash', async () => {
    const oldPepper = pepper('p1');
    const stored = await new PasswordHasher(oldPepper).hash('a long unusual passphrase');
    expect(
      (await new PasswordHasher(pepper('p1')).verify('a long unusual passphrase', stored)).valid,
    ).toBe(false);
    const rotated = new PasswordHasher(pepper('p2'), [oldPepper]);
    expect(await rotated.verify('a long unusual passphrase', stored)).toEqual({
      valid: true,
      needsRehash: true,
    });
    expect((await rotated.verify('x', { ...stored, pepperId: 'unknown' })).valid).toBe(false);
  });

  it('burns comparable time for unknown accounts', async () => {
    const hasher = new PasswordHasher(pepper('p1'));
    const stored = await hasher.hash('warm up');
    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    await hasher.burn('warm up');
    // Interleaved samples compared by median, so a burst of CPU contention from other processes
    // (e.g. parallel test suites) affects both sides alike instead of skewing one measurement.
    const real: number[] = [];
    const burned: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      real.push(await time(() => hasher.verify('guess-guess-guess', stored)));
      burned.push(await time(() => hasher.burn('guess-guess-guess')));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
    expect(median(burned)).toBeGreaterThan(median(real) * 0.5);
  });

  it('rejects malformed pepper configuration', () => {
    expect(() => parsePepper('p1:short')).toThrow();
    expect(() => parsePepper(`P 1:${randomBytes(32).toString('base64')}`)).toThrow();
  });
});

describe('assertStrongPassword', () => {
  // Known-weak test fixtures, not secrets.
  const WEAK = ['password1234', 'qwertyuiop12', 'aaaaaaaaaaaa', 'iloveyou2024!']; // gitleaks:allow
  it.each(WEAK)('rejects %s', (password) => {
    expect(() => {
      assertStrongPassword(password, []);
    }).toThrow(AppError);
  });

  it('rejects passwords built from the user identifiers', () => {
    expect(() => {
      assertStrongPassword('asha_sharma_rules_2026', ['asha_sharma', 'asha@example.com']);
    }).toThrow(AppError);
  });

  it('accepts long unpredictable passphrases', () => {
    expect(() => {
      assertStrongPassword('correct-horse-battery-staple-91', ['someone']);
    }).not.toThrow();
  });
});

describe('TOTP', () => {
  const secret = generateTotpSecret();
  const at = (timestamp: number) =>
    new TOTP({
      secret: Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate({ timestamp });

  it('produces an otpauth URI for authenticator apps', () => {
    expect(totpUri(secret, 'asha')).toMatch(/^otpauth:\/\/totp\/Tessera:asha\?.*secret=/);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts ±1 step of skew and rejects older codes', () => {
    const now = 1_800_000_000_000;
    expect(verifyTotp(secret, at(now), null, now)).not.toBeNull();
    expect(verifyTotp(secret, at(now - 30_000), null, now)).not.toBeNull();
    expect(verifyTotp(secret, at(now - 90_000), null, now)).toBeNull();
  });

  it('prevents replay of the same or earlier steps', () => {
    const now = 1_800_000_000_000;
    const step = verifyTotp(secret, at(now), null, now)!;
    expect(verifyTotp(secret, at(now), step, now)).toBeNull();
    expect(verifyTotp(secret, at(now + 30_000), step, now + 30_000)).toBe(step + 1);
  });
});

describe('recovery codes', () => {
  it('are 10 base32 characters, formatted in two groups, with distinct digests', () => {
    const codes = Array.from({ length: 200 }, generateRecoveryCode);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(new Set(codes).size).toBe(200);
    expect(formatRecoveryCode('ABCDE23456')).toBe('ABCDE-23456');
    expect(recoveryCodeDigest('ABCDE23456').equals(recoveryCodeDigest('ABCDE23457'))).toBe(false);
  });
});
