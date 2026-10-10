import { createHash } from 'node:crypto';

import { AppError } from '@tessera/platform';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';

/**
 * Feature flags (docs/admin.md §4, ADR-050): kill switches and staged rollouts. A person is in a
 * rollout when a stable hash of (flag, user) falls below the percentage, so they keep the same
 * answer while the percentage only grows. Changes come only from the admin console, after a
 * second admin approved them.
 */

export interface FeatureFlag {
  readonly key: string;
  readonly description: string;
  readonly kind: 'product' | 'security';
  readonly enabled: boolean;
  readonly rolloutPercent: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

const CACHE_MS = 15_000;

/** 0–99, stable per flag and person. */
export function rolloutBucket(key: string, userId: string): number {
  return (
    createHash('sha256').update(`tessera-flag:${key}:${userId}`).digest().readUInt32BE(0) % 100
  );
}

export class FlagsService {
  readonly #db: Kysely<Database>;
  #cache: { at: number; flags: Map<string, FeatureFlag> } | null = null;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async list(): Promise<FeatureFlag[]> {
    const rows = await this.#db.selectFrom('feature_flags').selectAll().orderBy('key').execute();
    return rows.map((row) => ({
      key: row.key,
      description: row.description,
      kind: row.kind,
      enabled: row.enabled,
      rolloutPercent: row.rollout_percent,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
  }

  async #flags(): Promise<Map<string, FeatureFlag>> {
    if (this.#cache !== null && Date.now() - this.#cache.at < CACHE_MS) return this.#cache.flags;
    const flags = new Map((await this.list()).map((flag) => [flag.key, flag]));
    this.#cache = { at: Date.now(), flags };
    return flags;
  }

  /**
   * Whether a feature is on (for this person, if given). An unknown flag is on: flags only ever
   * switch existing features off or roll them out, never unlock hidden behaviour.
   */
  async enabled(key: string, userId?: string): Promise<boolean> {
    const flag = (await this.#flags()).get(key);
    if (flag === undefined) return true;
    if (!flag.enabled) return false;
    if (flag.rolloutPercent >= 100) return true;
    if (userId === undefined) return false;
    return rolloutBucket(key, userId) < flag.rolloutPercent;
  }

  async forUser(userId: string): Promise<Record<string, boolean>> {
    const flags = await this.#flags();
    const result: Record<string, boolean> = {};
    for (const key of flags.keys()) result[key] = await this.enabled(key, userId);
    return result;
  }

  /** Applies an approved change (called by the admin module only). */
  async apply(
    key: string,
    change: { enabled: boolean; rolloutPercent: number },
    adminId: string,
  ): Promise<FeatureFlag> {
    const result = await this.#db
      .updateTable('feature_flags')
      .set({
        enabled: change.enabled,
        rollout_percent: change.rolloutPercent,
        updated_by: adminId,
        updated_at: new Date(),
      })
      .where('key', '=', key)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new AppError('NOT_FOUND');
    this.#cache = null;
    const flag = (await this.list()).find((f) => f.key === key);
    if (flag === undefined) throw new AppError('NOT_FOUND');
    return flag;
  }

  async get(key: string): Promise<FeatureFlag | null> {
    return (await this.list()).find((flag) => flag.key === key) ?? null;
  }
}
