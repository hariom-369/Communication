import type { MessageContent } from './content.js';

/**
 * Message franking, sender side (ADR-021, docs/moderation.md §3; the construction used by
 * Facebook Messenger, analysed by Grubbs, Lu and Ristenpart, CRYPTO 2017; review pending, S-10).
 *
 * A fresh 32-byte key goes inside the encrypted content; the commitment HMAC-SHA256(key, exact
 * JSON) goes to the server, which binds it to the delivery with its own tag. Only someone who
 * can decrypt the message learns the key, so the commitment reveals nothing on its own; a
 * recipient who reports the message hands over the JSON, and the server can check both.
 */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function frank(
  content: MessageContent,
): Promise<{ json: string; commitment: string }> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const json = JSON.stringify({ ...content, f: toBase64(key) });
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(json));
  return { json, commitment: toBase64(new Uint8Array(mac)) };
}
