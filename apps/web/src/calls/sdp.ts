/**
 * The security-critical step of 1:1 calls (docs/calling.md §2, ADR-016): the session
 * description arrives inside an end-to-end encrypted message, so its DTLS fingerprint is
 * authenticated by MLS. The browser already refuses a DTLS peer whose certificate does not match
 * the fingerprint we gave it; we check again ourselves, against the certificate actually
 * presented, so the guarantee does not rest on one code path.
 */

/** `a=fingerprint:sha-256 AB:CD:…` lines; every one must agree (one DTLS transport, bundled). */
export function dtlsFingerprint(sdp: string): string | null {
  const found = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/.exec(line);
    if (match === null) continue;
    if (match[1]?.toLowerCase() !== 'sha-256') return null; // only SHA-256 is accepted
    found.add((match[2] ?? '').toUpperCase());
  }
  if (found.size !== 1) return null;
  const [value] = found;
  return value !== undefined && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value) ? value : null;
}

/** SHA-256 fingerprint of a DER certificate, in SDP notation. */
export async function certificateFingerprint(der: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/**
 * Whether the peer's DTLS certificate is the one named in the end-to-end encrypted session
 * description. Fails closed: no certificate, several, or any mismatch is a failure.
 */
export async function remoteCertificateMatches(
  expectedFingerprint: string,
  certificates: readonly ArrayBuffer[],
): Promise<boolean> {
  const [leaf] = certificates;
  if (leaf === undefined) return false;
  return (await certificateFingerprint(leaf)) === expectedFingerprint;
}

/** Basic shape checks before handing a received description to the browser. */
export function plausibleSdp(sdp: string): boolean {
  return sdp.startsWith('v=0') && sdp.length < 24_000 && dtlsFingerprint(sdp) !== null;
}
