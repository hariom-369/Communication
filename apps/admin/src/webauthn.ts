import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

import { endpoints } from './endpoints.js';

/** Security keys (WebAuthn, via @simplewebauthn/browser). */

/** Registration options carry the user to create a credential for; assertion options do not. */
export function isRegistration(options: unknown): boolean {
  return typeof options === 'object' && options !== null && 'user' in options;
}

export async function answerKeyPrompt(options: unknown): Promise<Record<string, unknown>> {
  const response = isRegistration(options)
    ? await startRegistration({
        optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
      })
    : await startAuthentication({
        optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
      });
  return response as unknown as Record<string, unknown>;
}

/** Confirms it is you with your key (step-up for sensitive actions). */
export async function confirmWithKey(): Promise<void> {
  const { flowId, options } = await endpoints.reauthOptions();
  await endpoints.reauthVerify(flowId, await answerKeyPrompt(options));
}

/** The person dismissed or timed out the browser prompt. */
export function isKeyCancellation(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}
