import type { HealthCheck } from '@tessera/platform';
import { Redis } from 'ioredis';

/**
 * Valkey client (ADR-029). ioredis speaks the Redis protocol, which Valkey implements. Commands
 * fail fast instead of queueing while disconnected, so callers can apply their degraded modes.
 */
export function createValkey(url: string, connectionName: string): Redis {
  return new Redis(url, {
    connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

export function valkeyHealthCheck(client: Redis): HealthCheck {
  return {
    name: 'valkey',
    check: async (signal) => {
      signal.throwIfAborted();
      await client.ping();
    },
  };
}
