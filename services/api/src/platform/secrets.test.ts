import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  parseKeyring,
  randomDigits,
  randomToken,
  SecretBox,
} from './secrets.js';

const key = () => randomBytes(32).toString('base64');

describe('randomToken / randomDigits', () => {
  it('produces 256-bit url-safe tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('produces zero-padded digit codes with roughly uniform digits', () => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 2000; i++) {
      const code = randomDigits(6);
      expect(code).toMatch(/^\d{6}$/);
      for (const digit of code) counts[Number(digit)]! += 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(1000); // expected 1200 each
  });
});

describe('SecretBox', () => {
  it('round-trips and binds ciphertext to its context', () => {
    const box = new SecretBox(parseKeyring(`k1:${key()}`));
    const sealed = box.seal(Buffer.from('JBSWY3DPEHPK3PXP'), 'totp:user-a');
    expect(sealed).toMatch(/^v1\.k1\./);
    expect(box.open(sealed, 'totp:user-a').toString()).toBe('JBSWY3DPEHPK3PXP');
    expect(() => box.open(sealed, 'totp:user-b')).toThrow();
  });

  it('detects tampering', () => {
    const box = new SecretBox(parseKeyring(`k1:${key()}`));
    const [v, id, nonce, body] = box.seal(Buffer.from('secret'), 'ctx').split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[0]! ^= 1;
    expect(() =>
      box.open([v, id, nonce, flipped.toString('base64url')].join('.'), 'ctx'),
    ).toThrow();
  });

  it('decrypts with retired keys and reports when rotation is needed', () => {
    const oldKey = key();
    const before = new SecretBox(parseKeyring(`k1:${oldKey}`));
    const sealed = before.seal(Buffer.from('secret'), 'ctx');
    const after = new SecretBox(parseKeyring(`k2:${key()},k1:${oldKey}`));
    expect(after.open(sealed, 'ctx').toString()).toBe('secret');
    expect(after.needsRotation(sealed)).toBe(true);
    expect(after.needsRotation(after.seal(Buffer.from('x'), 'ctx'))).toBe(false);
  });

  it('rejects malformed keyrings', () => {
    expect(() => parseKeyring('')).toThrow();
    expect(() => parseKeyring('k1:short')).toThrow(/32 bytes/);
    expect(() => parseKeyring(`k1:${key()},k1:${key()}`)).toThrow(/duplicate/);
    expect(() => parseKeyring(`BAD ID:${key()}`)).toThrow();
  });
});

describe('constantTimeEqual', () => {
  it('compares buffers of any length safely', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
