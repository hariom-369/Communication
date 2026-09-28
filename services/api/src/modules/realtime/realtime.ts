import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from '@tessera/validation';
import type { Redis } from 'ioredis';

import { randomToken } from '../../platform/secrets.js';

/**
 * API side of the realtime tier: single-use connection tickets and presence reads.
 * Keys (shared contract with services/realtime):
 *   <prefix>:rt:ticket:<ticket>       → {"userId","sessionId"}  (30 s, consumed with GETDEL)
 *   <prefix>:presence:online:<userId> → "1"                     (refreshed while connected)
 *   <prefix>:presence:seen:<userId>   → epoch ms                (last activity)
 */
export const TICKET_TTL_SECONDS = 30;

export interface PresenceDirectory {
  privacySettings(userId: string): Promise<PrivacySettings>;
  areContacts(userA: string, userB: string): Promise<boolean>;
}

export class RealtimeService {
  readonly #valkey: Redis;
  readonly #prefix: string;
  readonly #directory: PresenceDirectory;

  constructor(valkey: Redis, prefix: string, directory: PresenceDirectory) {
    this.#valkey = valkey;
    this.#prefix = prefix;
    this.#directory = directory;
  }

  async issueTicket(userId: string, sessionId: string): Promise<string> {
    const ticket = randomToken(32);
    await this.#valkey.set(
      `${this.#prefix}:rt:ticket:${ticket}`,
      JSON.stringify({ userId, sessionId }),
      'EX',
      TICKET_TTL_SECONDS,
    );
    return ticket;
  }

  /**
   * Presence of `targetId` as seen by `viewerId` (docs/privacy.md §2): governed by the target's
   * "last seen" and "online" settings, and reciprocal — if the viewer hides their own last seen,
   * they cannot see anyone else's. Hidden values are `null`, indistinguishable from "unknown".
   */
  async presence(
    viewerId: string,
    targetId: string,
  ): Promise<{ online: boolean | null; lastSeenAt: string | null }> {
    const [target, viewer] = await Promise.all([
      this.#directory.privacySettings(targetId),
      viewerId === targetId
        ? Promise.resolve(DEFAULT_PRIVACY_SETTINGS)
        : this.#directory.privacySettings(viewerId),
    ]);
    const hidden = { online: null, lastSeenAt: null };
    if (viewer.lastSeen === 'nobody' || target.lastSeen === 'nobody') return hidden;
    if (target.lastSeen === 'contacts' && !(await this.#directory.areContacts(viewerId, targetId)))
      return hidden;

    const [online, seen] = await this.#valkey.mget(
      `${this.#prefix}:presence:online:${targetId}`,
      `${this.#prefix}:presence:seen:${targetId}`,
    );
    return {
      online: target.onlineStatus === 'nobody' ? null : online === '1',
      lastSeenAt:
        seen === null || Number.isNaN(Number(seen)) ? null : new Date(Number(seen)).toISOString(),
    };
  }
}
