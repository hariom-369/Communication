import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseCertificate, verifyCertificate } from './certificate.js';

/** Produced by the Rust crypto core (WASM build), so this also checks cross-implementation parity. */
const fixture = JSON.parse(
  readFileSync(new URL('./testdata/certificate.json', import.meta.url), 'utf8'),
) as {
  userId: string;
  deviceId: string;
  askPublicKey: string;
  askVersion: number;
  certificate: string;
};

const bytes = Buffer.from(fixture.certificate, 'base64');
const ask = Buffer.from(fixture.askPublicKey, 'base64');

describe('device certificates', () => {
  it('parses and verifies certificates produced by the Rust crypto core', () => {
    const certificate = parseCertificate(bytes);
    expect(certificate).toMatchObject({
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      askVersion: fixture.askVersion,
      ciphersuites: [1],
    });
    expect(verifyCertificate(certificate!, ask)).toBe(true);
  });

  it('rejects any single-bit modification, other keys, truncation and trailing bytes', () => {
    for (let index = 0; index < bytes.length; index += 1) {
      const tampered = Buffer.from(bytes);
      tampered[index]! ^= 0x01;
      const parsed = parseCertificate(tampered);
      expect(parsed === null || !verifyCertificate(parsed, ask), `byte ${index}`).toBe(true);
    }
    const other = Buffer.from(ask);
    other[0]! ^= 0x01;
    expect(verifyCertificate(parseCertificate(bytes)!, other)).toBe(false);
    expect(verifyCertificate(parseCertificate(bytes)!, Buffer.alloc(31))).toBe(false);
    expect(parseCertificate(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(parseCertificate(Buffer.concat([bytes, Buffer.alloc(1)]))).toBeNull();
    expect(parseCertificate(Buffer.alloc(0))).toBeNull();
  });
});
