import type { Logger } from '@tessera/platform';
import { TIER_LIMITS, type Entitlement, type Entitlements, type Tier } from '@tessera/validation';
import type { Redis } from 'ioredis';
import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';

/**
 * Entitlements (docs/billing.md §1, ADR-051): what an account may do, by tier. Every other module
 * asks here ("what is this account's upload limit?") and never looks at billing. Billing tells
 * this module when a paid tier starts, changes or ends, inside the same transaction as the
 * subscription change; the cache entry is dropped once that commits, so the new limits apply on
 * the next request (and within 60 seconds even if dropping the entry failed).
 */

type Executor = Kysely<Database> | Transaction<Database>;

const CACHE_SECONDS = 60;

interface CachedTier {
  readonly tier: Tier;
  readonly validUntil: string | null;
}

export class EntitlementsService {
  readonly #db: Kysely<Database>;
  readonly #valkey: Redis;
  readonly #prefix: string;
  readonly #logger: Logger;

  constructor(db: Kysely<Database>, valkey: Redis, keyPrefix: string, logger: Logger) {
    this.#db = db;
    this.#valkey = valkey;
    this.#prefix = `${keyPrefix}:entitlements`;
    this.#logger = logger;
  }

  #key(userId: string): string {
    return `${this.#prefix}:${userId}`;
  }

  async #load(userId: string, now: Date): Promise<{ tier: Tier; validUntil: Date | null }> {
    const row = await this.#db
      .selectFrom('account_tiers')
      .select(['tier', 'valid_until'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined || row.valid_until.getTime() <= now.getTime())
      return { tier: 'free', validUntil: null };
    return { tier: row.tier, validUntil: row.valid_until };
  }

  async #cached(userId: string): Promise<CachedTier | null> {
    try {
      const raw = await this.#valkey.get(this.#key(userId));
      return raw === null ? null : (JSON.parse(raw) as CachedTier);
    } catch {
      return null; // the database is the source of truth
    }
  }

  /** The account's tier and limits right now. */
  async forUser(userId: string, now = new Date()): Promise<Entitlements> {
    let cached = await this.#cached(userId);
    // A cached paid tier still ends exactly on time.
    if (
      cached !== null &&
      cached.validUntil !== null &&
      new Date(cached.validUntil).getTime() <= now.getTime()
    )
      cached = null;
    if (cached === null) {
      const loaded = await this.#load(userId, now);
      cached = { tier: loaded.tier, validUntil: loaded.validUntil?.toISOString() ?? null };
      await this.#valkey
        .set(this.#key(userId), JSON.stringify(cached), 'EX', CACHE_SECONDS)
        .catch(() => undefined);
    }
    return {
      tier: cached.tier,
      validUntil: cached.validUntil,
      limits: { ...TIER_LIMITS[cached.tier] },
    };
  }

  async limit(userId: string, entitlement: Entitlement): Promise<number> {
    return (await this.forUser(userId)).limits[entitlement];
  }

  /**
   * Billing: because of `subscriptionId` the account has `grant.tier` until `grant.validUntil`
   * (or, with `null`, loses what that subscription granted). Call inside the billing transaction, then `invalidate` after it commits.
   */
  async setTier(
    executor: Executor,
    userId: string,
    subscriptionId: string,
    grant: { tier: Exclude<Tier, 'free'>; validUntil: Date } | null,
  ): Promise<void> {
    if (grant === null) {
      // Only the subscription that granted the tier can take it away.
      await executor
        .deleteFrom('account_tiers')
        .where('user_id', '=', userId)
        .where('subscription_id', '=', subscriptionId)
        .execute();
      return;
    }
    await executor
      .insertInto('account_tiers')
      .values({
        user_id: userId,
        tier: grant.tier,
        valid_until: grant.validUntil,
        subscription_id: subscriptionId,
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          tier: grant.tier,
          valid_until: grant.validUntil,
          subscription_id: subscriptionId,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  async invalidate(userId: string): Promise<void> {
    try {
      await this.#valkey.del(this.#key(userId));
    } catch (error) {
      // The entry expires within CACHE_SECONDS anyway.
      this.#logger.warn('entitlements.invalidate_failed', this.#logger.errorFields(error));
    }
  }
}
