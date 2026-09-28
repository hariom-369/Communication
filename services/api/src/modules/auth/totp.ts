import { Secret, TOTP } from 'otpauth';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s — the parameters every authenticator app supports).
 * `window: 1` tolerates ±1 step of clock skew. Replay protection: a code is accepted only if its
 * time step is newer than the last accepted step (stored per user).
 */
const PERIOD_SECONDS = 30;

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totp(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: 'Tessera',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function totpUri(secretBase32: string, label: string): string {
  return totp(secretBase32, label).toString();
}

/** Returns the accepted time step, or null if the code is invalid or replayed. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: number | null,
  now = Date.now(),
): number | null {
  const delta = totp(secretBase32, 'verify').validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / PERIOD_SECONDS) + delta;
  if (lastUsedStep !== null && step <= lastUsedStep) return null;
  return step;
}
