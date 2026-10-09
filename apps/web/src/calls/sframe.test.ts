// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AES_128_GCM_SHA256_128,
  AES_256_GCM_SHA512_128,
  decodeHeader,
  deriveFrameKey,
  encodeHeader,
  frameNonce,
  hkdfExpandBlock,
  keyId,
  open,
  seal,
  splitKeyId,
} from './sframe.js';
import vectors from './sframe-vectors.json';

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const suites = { 4: AES_128_GCM_SHA256_128, 5: AES_256_GCM_SHA512_128 } as const;

describe('SFrame header (RFC 9605 §4.3, Appendix C.1)', () => {
  it(`round-trips all ${vectors.header.length} header vectors`, () => {
    for (const v of vectors.header) {
      // JSON numbers above 2^53 lose precision, so take exact values from the encoding.
      const decoded = decodeHeader(hex(v.encoded));
      expect(decoded?.length).toBe(v.encoded.length / 2);
      expect(toHex(encodeHeader(decoded!.kid, decoded!.ctr))).toBe(v.encoded);
      if (Number.isSafeInteger(v.kid)) expect(decoded!.kid).toBe(BigInt(v.kid));
      if (Number.isSafeInteger(v.ctr)) expect(decoded!.ctr).toBe(BigInt(v.ctr));
    }
  });

  it('rejects truncated headers and out-of-range values', () => {
    expect(decodeHeader(new Uint8Array(0))).toBeNull();
    expect(decodeHeader(hex('8a'))).toBeNull();
    expect(decodeHeader(hex('8aff'))).toBeNull();
    expect(() => encodeHeader(-1n, 0n)).toThrow(RangeError);
    expect(() => encodeHeader(0n, 1n << 64n)).toThrow(RangeError);
  });
});

describe('SFrame encryption (RFC 9605 §4.4, Appendix C.4)', () => {
  it.each(vectors.sframe.map((v) => [v.cipher_suite, v] as const))('suite %s', async (id, v) => {
    const suite = suites[id as 4 | 5];
    const kid = BigInt(v.kid);
    const ctr = BigInt(v.ctr);
    const key = await deriveFrameKey(suite, kid, hex(v.base_key));
    expect(toHex(key.rawKey)).toBe(v.sframe_key);
    expect(toHex(key.salt)).toBe(v.sframe_salt);
    expect(toHex(frameNonce(key.salt, ctr))).toBe(v.nonce);
    const sealed = await seal(key, ctr, hex(v.metadata), hex(v.pt));
    expect(toHex(sealed)).toBe(v.ct);
    const header = decodeHeader(sealed)!;
    expect(toHex(await open(key, header, hex(v.metadata), sealed))).toBe(v.pt);
  });

  it('fails closed on any tampering, wrong metadata or wrong key', async () => {
    const v = vectors.sframe.find((x) => x.cipher_suite === 4)!;
    const key = await deriveFrameKey(AES_128_GCM_SHA256_128, BigInt(v.kid), hex(v.base_key));
    const sealed = hex(v.ct);
    const header = decodeHeader(sealed)!;
    const flipped = sealed.slice();
    flipped[flipped.length - 1]! ^= 1;
    await expect(open(key, header, hex(v.metadata), flipped)).rejects.toThrow();
    await expect(open(key, header, new Uint8Array(0), sealed)).rejects.toThrow();
    const other = await deriveFrameKey(AES_128_GCM_SHA256_128, BigInt(v.kid), new Uint8Array(16));
    await expect(open(other, header, hex(v.metadata), sealed)).rejects.toThrow();
    // A header edited to another counter changes the nonce and the AAD.
    const recounted = decodeHeader(hex('9901234568'))!;
    const forged = sealed.slice();
    forged[4] = 0x68;
    await expect(open(key, recounted, hex(v.metadata), forged)).rejects.toThrow();
  });
});

describe('MLS-based sender keys (RFC 9605 §5.2)', () => {
  it('expands with HKDF exactly as RFC 5869 (test case 1)', async () => {
    const okm = await hkdfExpandBlock(
      'SHA-256',
      hex('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5'),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      32,
    );
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf');
  });

  it('packs the sender index and the low epoch bits into the key ID', () => {
    expect(keyId(0, 0)).toBe(0n);
    expect(keyId(3, 17)).toBe((3n << 4n) + 1n);
    expect(splitKeyId(keyId(1234, 35))).toEqual({ senderIndex: 1234, epochBits: 3 });
  });
});
