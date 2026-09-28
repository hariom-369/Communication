import type { Logger } from '@tessera/platform';
import { userChannel, type RealtimeEvent } from '@tessera/validation';
import type { Redis } from 'ioredis';

/**
 * Publishes realtime hints to the WebSocket tier through Valkey pub/sub, one channel per user
 * (docs/realtime.md §3). Delivery is best-effort by design: messages are durable in the mailbox
 * and clients re-sync on reconnect, so a lost hint only delays display, never loses data.
 */
export interface RealtimePublisher {
  publish(userIds: readonly string[], event: RealtimeEvent): void;
}

export class ValkeyRealtimePublisher implements RealtimePublisher {
  readonly #client: Redis;
  readonly #prefix: string;
  readonly #logger: Logger;

  constructor(client: Redis, prefix: string, logger: Logger) {
    this.#client = client;
    this.#prefix = prefix;
    this.#logger = logger;
  }

  publish(userIds: readonly string[], event: RealtimeEvent): void {
    if (userIds.length === 0) return;
    const payload = JSON.stringify(event);
    const pipeline = this.#client.pipeline();
    for (const userId of new Set(userIds))
      pipeline.publish(userChannel(this.#prefix, userId), payload);
    pipeline.exec().catch((error: unknown) => {
      this.#logger.warn('realtime.publish_failed', {
        count: userIds.length,
        ...this.#logger.errorFields(error),
      });
    });
  }
}
