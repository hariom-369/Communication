import type { Redis } from 'ioredis';
import { z } from 'zod';

import { randomToken } from '../../platform/secrets.js';

/**
 * Single-use WebAuthn challenges kept in Valkey for 5 minutes. `take` uses GETDEL, so a
 * challenge can be redeemed at most once even with concurrent requests (replay protection).
 */
const TTL_MS = 5 * 60_000;

const flowSchema = z.object({
  kind: z.enum(['register', 'login', 'reauth']),
  challenge: z.string(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
});
export type ChallengeFlow = z.infer<typeof flowSchema>;

export class ChallengeStore {
  readonly #client: Redis;
  readonly #prefix: string;

  constructor(client: Redis, keyPrefix: string) {
    this.#client = client;
    this.#prefix = `${keyPrefix}:webauthn`;
  }

  async put(flow: ChallengeFlow): Promise<string> {
    const flowId = randomToken(24);
    await this.#client.set(`${this.#prefix}:${flowId}`, JSON.stringify(flow), 'PX', TTL_MS);
    return flowId;
  }

  async take(flowId: string): Promise<ChallengeFlow | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(flowId)) return null;
    const raw = await this.#client.getdel(`${this.#prefix}:${flowId}`);
    if (raw === null) return null;
    const parsed = flowSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }
}
