import { createHash } from 'node:crypto';

import { PUSH_PAYLOAD_BYTES, type PushPayload } from '@tessera/validation';
import webpush from 'web-push';

import {
  parseDeliveryUrl,
  safePost,
  SafeFetchError,
  type SafePostTransport,
} from '../../platform/safe-fetch/index.js';

/**
 * Web Push delivery (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
 * both done by the `web-push` library — no protocol code of our own. Requests are sent through the
 * SSRF-hardened POST to allow-listed push services only (docs/notifications.md §5).
 *
 * Payloads carry no content (docs/notifications.md §2) and are padded to one size, so the push
 * service sees neither what happened nor which kind of event it was.
 */

export interface VapidConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: Buffer;
  readonly auth: Buffer;
}

export interface PushMessage {
  readonly payload: PushPayload;
  readonly ttlSeconds: number;
  readonly urgency: 'normal' | 'high';
  /**
   * Pending pushes with the same topic replace each other at the push service. Derived per
   * subscription, so the service cannot tell that two people's pushes concern one conversation.
   */
  readonly topicKey?: string;
}

/** `gone`: the subscription no longer exists (404/410) and must be deleted. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

/** Pads the JSON payload with a `p` field to exactly PUSH_PAYLOAD_BYTES. */
export function encodePayload(payload: PushPayload): string {
  const { p: _ignored, ...rest } = payload;
  const base = JSON.stringify({ ...rest, p: '' });
  const missing = PUSH_PAYLOAD_BYTES - Buffer.byteLength(base);
  if (missing < 0) throw new Error('push payload too large');
  return JSON.stringify({ ...rest, p: '='.repeat(missing) });
}

export function pushTopic(auth: Buffer, key: string): string {
  return createHash('sha256').update(auth).update(key).digest('base64url').slice(0, 32);
}

export interface PushSenderOptions {
  readonly vapid: VapidConfig;
  readonly allowedHosts: readonly string[];
  /** Non-production only: an extra endpoint origin reached with plain fetch (E2E push service). */
  readonly testOrigin?: string;
  readonly transport?: SafePostTransport;
}

export class PushSender {
  readonly #options: PushSenderOptions;

  constructor(options: PushSenderOptions) {
    this.#options = options;
  }

  get publicKey(): string {
    return this.#options.vapid.publicKey;
  }

  /** Whether an endpoint may be stored (checked when the browser registers it). */
  acceptsEndpoint(endpoint: string): boolean {
    if (this.#isTestEndpoint(endpoint)) return true;
    try {
      parseDeliveryUrl(endpoint, this.#options.allowedHosts);
      return true;
    } catch {
      return false;
    }
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    const details = webpush.generateRequestDetails(
      {
        endpoint: target.endpoint,
        keys: {
          p256dh: target.p256dh.toString('base64url'),
          auth: target.auth.toString('base64url'),
        },
      },
      encodePayload(message.payload),
      {
        vapidDetails: this.#options.vapid,
        TTL: message.ttlSeconds,
        urgency: message.urgency,
        contentEncoding: 'aes128gcm',
        ...(message.topicKey === undefined
          ? {}
          : { topic: pushTopic(target.auth, message.topicKey) }),
      },
    );
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.headers as Record<string, unknown>))
      headers[name] = typeof value === 'string' ? value : JSON.stringify(value);
    let status: number;
    try {
      status = this.#isTestEndpoint(target.endpoint)
        ? await testPost(target.endpoint, headers, details.body)
        : await safePost(
            target.endpoint,
            this.#options.allowedHosts,
            headers,
            details.body,
            this.#options.transport,
          );
    } catch (error) {
      if (error instanceof SafeFetchError) return 'failed';
      throw error;
    }
    if (status === 404 || status === 410) return 'gone';
    return status >= 200 && status < 300 ? 'sent' : 'failed';
  }

  #isTestEndpoint(endpoint: string): boolean {
    const origin = this.#options.testOrigin;
    if (origin === undefined) return false;
    try {
      return new URL(endpoint).origin === new URL(origin).origin;
    } catch {
      return false;
    }
  }
}

async function testPost(
  endpoint: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<number> {
  const { 'Content-Length': _length, ...rest } = headers;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: rest,
    body: new Uint8Array(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
}
