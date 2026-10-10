import type { Redis } from 'ioredis';

/**
 * Coalescing queue for pushes (docs/notifications.md §3), in Valkey.
 *
 * One entry per person and conversation (or channel). New messages within the coalescing window
 * join the pending entry; after a push, the next one waits until the minimum interval has passed
 * — it is delayed, never dropped, so the last message of a burst still produces a notification.
 * All keys share the `{notify}` hash tag so the scripts stay on one slot in a cluster.
 */

const ENQUEUE = `
local queue = KEYS[1]
local lastPrefix = ARGV[1]
local now = tonumber(ARGV[2])
local coalesce = tonumber(ARGV[3])
for i = 4, #ARGV do
  local member = ARGV[i]
  local due = now + coalesce
  local wait = redis.call('PTTL', lastPrefix .. member)
  if wait > 0 and now + wait > due then due = now + wait end
  redis.call('ZADD', queue, 'NX', due, member)
end
return 0
`;

const CLAIM = `
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #items > 0 then redis.call('ZREM', KEYS[1], unpack(items)) end
return items
`;

/** What a queue entry is about. */
export type QueueEntry =
  | { readonly kind: 'conversation'; readonly userId: string; readonly id: string }
  | { readonly kind: 'channel'; readonly userId: string; readonly id: string };

export function entryKey(entry: QueueEntry): string {
  return `${entry.kind === 'conversation' ? 'm' : 'c'}:${entry.userId}:${entry.id}`;
}

export function parseEntry(key: string): QueueEntry | null {
  const [kind, userId, id] = key.split(':');
  if (userId === undefined || id === undefined) return null;
  if (kind === 'm') return { kind: 'conversation', userId, id };
  if (kind === 'c') return { kind: 'channel', userId, id };
  return null;
}

export interface FanoutJob {
  readonly channelId: string;
  /** Subscribers after this user id are still to be queued. */
  readonly after: string | null;
}

export class NotifyQueue {
  readonly #valkey: Redis;
  readonly #queue: string;
  readonly #last: string;
  readonly #fanout: string;
  readonly #coalesceMs: number;
  readonly #minIntervalMs: number;

  constructor(
    valkey: Redis,
    prefix: string,
    timing: { readonly coalesceMs: number; readonly minIntervalMs: number },
  ) {
    this.#valkey = valkey;
    this.#queue = `${prefix}:{notify}:queue`;
    this.#last = `${prefix}:{notify}:last:`;
    this.#fanout = `${prefix}:{notify}:fanout`;
    this.#coalesceMs = timing.coalesceMs;
    this.#minIntervalMs = timing.minIntervalMs;
  }

  async enqueue(entries: readonly QueueEntry[], now = Date.now()): Promise<void> {
    // Batches keep each script call short (large groups enqueue one entry per member).
    for (let i = 0; i < entries.length; i += 500) {
      const keys = entries.slice(i, i + 500).map(entryKey);
      await this.#valkey.eval(
        ENQUEUE,
        1,
        this.#queue,
        this.#last,
        String(now),
        String(this.#coalesceMs),
        ...keys,
      );
    }
  }

  /** Removes and returns entries that are due. */
  async claimDue(now: number, limit: number): Promise<QueueEntry[]> {
    const keys = (await this.#valkey.eval(CLAIM, 1, this.#queue, String(now), String(limit))) as
      string[] | null;
    return (keys ?? []).flatMap((key) => {
      const entry = parseEntry(key);
      return entry === null ? [] : [entry];
    });
  }

  /** Starts the minimum interval after a push for this entry. */
  async markSent(entry: QueueEntry): Promise<void> {
    await this.#valkey.set(`${this.#last}${entryKey(entry)}`, '1', 'PX', this.#minIntervalMs);
  }

  async pushFanout(job: FanoutJob): Promise<void> {
    await this.#valkey.rpush(this.#fanout, JSON.stringify(job));
  }

  async popFanout(): Promise<FanoutJob | null> {
    const raw = await this.#valkey.lpop(this.#fanout);
    if (raw === null) return null;
    try {
      const job = JSON.parse(raw) as FanoutJob;
      return typeof job.channelId === 'string' ? job : null;
    } catch {
      return null;
    }
  }
}
