// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  certificateFingerprint,
  dtlsFingerprint,
  plausibleSdp,
  remoteCertificateMatches,
} from './sdp.js';

const FP = Array.from({ length: 32 }, (_, i) =>
  (i * 7).toString(16).padStart(2, '0').toUpperCase(),
).join(':');
const OTHER = FP.replace(/^../, 'FF');
const sdp = (...fingerprints: string[]) =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    ...fingerprints.map((f) => `a=fingerprint:sha-256 ${f}`),
    '',
  ].join('\r\n');

describe('DTLS fingerprints from end-to-end encrypted session descriptions', () => {
  it('reads one SHA-256 fingerprint, case-insensitively', () => {
    expect(dtlsFingerprint(sdp(FP))).toBe(FP);
    expect(dtlsFingerprint(sdp(FP.toLowerCase(), FP))).toBe(FP);
  });

  it('refuses missing, conflicting, malformed or weaker fingerprints', () => {
    expect(dtlsFingerprint('v=0\r\n')).toBeNull();
    expect(dtlsFingerprint(sdp(FP, OTHER))).toBeNull();
    expect(dtlsFingerprint(sdp('AB:CD'))).toBeNull();
    expect(dtlsFingerprint(`v=0\r\na=fingerprint:sha-1 ${FP.slice(0, 59)}\r\n`)).toBeNull();
    expect(
      dtlsFingerprint(
        `v=0\r\na=fingerprint:sha-1 ${FP.slice(0, 59)}\r\na=fingerprint:sha-256 ${FP}\r\n`,
      ),
    ).toBeNull();
    expect(plausibleSdp(sdp(FP))).toBe(true);
    expect(plausibleSdp(`x${sdp(FP)}`)).toBe(false);
  });

  it('matches only the certificate the fingerprint names (substitution fails)', async () => {
    const genuine = new TextEncoder().encode('genuine certificate DER').buffer;
    const substitute = new TextEncoder().encode('attacker certificate DER').buffer;
    const expected = await certificateFingerprint(genuine);
    expect(expected).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(await remoteCertificateMatches(expected, [genuine])).toBe(true);
    expect(await remoteCertificateMatches(expected, [substitute])).toBe(false);
    expect(await remoteCertificateMatches(expected, [substitute, genuine])).toBe(false);
    expect(await remoteCertificateMatches(expected, [])).toBe(false);
  });
});
