import { createHmac, randomBytes } from 'node:crypto';

import type { IceConfig } from '@tessera/validation';

/**
 * Short-lived TURN credentials in coturn's shared-secret ("TURN REST API") scheme
 * (`use-auth-secret` + `static-auth-secret`): the username is `<expiry unix seconds>:<label>` and
 * the password is base64(HMAC-SHA1(secret, username)). coturn recomputes the HMAC and refuses
 * expired usernames, so nothing is stored and nothing long-lived reaches browsers.
 *
 * The label is random rather than a user or device ID: TURN servers log usernames, and they
 * have no need to know who is relaying.
 */

export interface TurnConfig {
  readonly urls: readonly string[];
  readonly secret: string;
  readonly ttlSeconds: number;
}

export function turnCredential(
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): { username: string; credential: string } {
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:${randomBytes(8).toString('hex')}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function iceConfig(
  turn: TurnConfig | null,
  stunUrls: readonly string[],
  now = Date.now(),
): IceConfig {
  const iceServers: IceConfig['iceServers'] = [];
  if (stunUrls.length > 0) iceServers.push({ urls: [...stunUrls] });
  if (turn !== null) {
    iceServers.push({ urls: [...turn.urls], ...turnCredential(turn.secret, turn.ttlSeconds, now) });
  }
  return { iceServers, relayAvailable: turn !== null, ttlSeconds: turn?.ttlSeconds ?? 0 };
}
