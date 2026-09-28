import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

/** Thin wrapper over the browser WebAuthn API (via @simplewebauthn/browser). */

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

export async function createPasskey(
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  return response as unknown as Record<string, unknown>;
}

export async function getPasskeyAssertion(
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return response as unknown as Record<string, unknown>;
}

/** Friendly default passkey name from the platform, e.g. "Chrome on Windows". */
export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const pick = (options: readonly [string, string][], fallback: string) =>
    options.find(([marker]) => ua.includes(marker))?.[1] ?? fallback;
  const browser = pick(
    [
      ['Edg/', 'Edge'],
      ['Firefox/', 'Firefox'],
      ['Chrome/', 'Chrome'],
      ['Safari/', 'Safari'],
    ],
    'Browser',
  );
  const os = pick(
    [
      ['Android', 'Android'],
      ['iPhone', 'iOS'],
      ['iPad', 'iOS'],
      ['Windows', 'Windows'],
      ['Mac OS X', 'macOS'],
      ['Linux', 'Linux'],
    ],
    'this device',
  );
  return `${browser} on ${os}`;
}

/** The user dismissed or timed out the browser prompt — not an error worth alarming about. */
export function isPasskeyCancellation(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}
