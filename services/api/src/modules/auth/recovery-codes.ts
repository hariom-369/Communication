import { randomBytes } from 'node:crypto';

import { sha256 } from '../../platform/secrets.js';

/**
 * Recovery codes (docs/authentication.md §2.3): 10 single-use codes of 10 base32 characters
 * (50 bits each), shown once, stored as SHA-256 digests (high entropy, so a fast hash suffices).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let code = '';
  for (const byte of bytes) code += ALPHABET.charAt(byte & 31);
  return code;
}

/** Display form, e.g. `ABCDE-FGH23`. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function recoveryCodeDigest(normalizedCode: string): Buffer {
  return sha256(`tessera-recovery-code:${normalizedCode}`);
}
