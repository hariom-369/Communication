import { DEV_PLAINTEXT_CIPHERSUITE } from '@tessera/validation';

import { contentSchema, type MessageCodec } from './content.js';

/**
 * DEV-PLAINTEXT-CODEC — development only. Encodes message content as base64 JSON with NO
 * encryption, so the messaging transport can be built and tested before end-to-end encryption
 * (Phase 4). It is compiled only into builds with VITE_DEV_PLAINTEXT_MESSAGING=true, and the API
 * refuses its ciphersuite (0) unless MESSAGING_DEV_PLAINTEXT is set, which production forbids.
 */
export const DEV_PLAINTEXT_CODEC_NAME = 'tessera-dev-plaintext-codec-v1';

export function createDevPlaintextCodec(): MessageCodec {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    name: DEV_PLAINTEXT_CODEC_NAME,
    ciphersuite: DEV_PLAINTEXT_CIPHERSUITE,
    unprotected: true,
    encode: (content) => {
      const bytes = encoder.encode(JSON.stringify(content));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return Promise.resolve(btoa(binary));
    },
    decode: (ciphertext) => {
      try {
        const binary = atob(ciphertext);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const parsed = contentSchema.safeParse(JSON.parse(decoder.decode(bytes)));
        return Promise.resolve(parsed.success ? parsed.data : null);
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}
