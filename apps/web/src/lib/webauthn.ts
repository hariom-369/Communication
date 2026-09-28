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
  // Ask for the PRF extension so the passkey can also unlock encrypted backups
  // (docs/encrypted-backups.md §4). Authenticators without it simply ignore the request.
  const withPrf = {
    ...options,
    extensions: { ...(options['extensions'] as Record<string, unknown> | undefined), prf: {} },
  };
  const response = await startRegistration({
    optionsJSON: withPrf as unknown as PublicKeyCredentialCreationOptionsJSON,
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

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** The passkey does not support the PRF extension, so it cannot unlock backups. */
export class PrfUnsupportedError extends Error {
  constructor() {
    super('This passkey cannot be used to unlock backups.');
    this.name = 'PrfUnsupportedError';
  }
}

export interface PrfResult {
  /** base64url credential id. */
  readonly credentialId: string;
  /** 32-byte PRF output (WebAuthn PRF extension / CTAP2 hmac-secret). */
  readonly output: Uint8Array;
}

/**
 * Evaluates the WebAuthn PRF extension (W3C WebAuthn Level 3 §10.1.4). The challenge is local
 * and random: this assertion is never sent to the server, only the PRF output is used, and only
 * inside this browser (to unwrap or wrap the backup key).
 *
 * With `credentials` empty, any discoverable passkey for this site may answer with `salt`;
 * otherwise only the listed credentials, each with its own salt (base64).
 */
export async function passkeyPrf(
  salt: Uint8Array<ArrayBuffer> | null,
  credentials: readonly { credentialId: string; salt: string }[] = [],
): Promise<PrfResult> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const prf: AuthenticationExtensionsPRFInputs =
    credentials.length === 0
      ? { eval: { first: salt ?? crypto.getRandomValues(new Uint8Array(32)) } }
      : {
          evalByCredential: Object.fromEntries(
            credentials.map((entry) => [
              entry.credentialId,
              { first: Uint8Array.from(atob(entry.salt), (c) => c.charCodeAt(0)) },
            ]),
          ),
        };
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      userVerification: 'required',
      allowCredentials: credentials.map((entry) => ({
        type: 'public-key' as const,
        id: fromBase64Url(entry.credentialId),
      })),
      extensions: { prf },
    },
  })) as PublicKeyCredential | null;
  if (credential === null) throw new PrfUnsupportedError();
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (first === undefined) throw new PrfUnsupportedError();
  const output =
    first instanceof ArrayBuffer
      ? new Uint8Array(first)
      : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  if (output.length !== 32) throw new PrfUnsupportedError();
  return { credentialId: toBase64Url(credential.rawId), output: new Uint8Array(output) };
}
