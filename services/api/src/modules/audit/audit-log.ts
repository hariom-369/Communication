import { newId } from '@tessera/shared';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import { sha256 } from '../../platform/secrets.js';

/**
 * Append-only, hash-chained audit log (docs/security.md §11).
 *
 * hash(n) = SHA-256(hash(n-1) || canonical JSON of row n). Appends are serialised with a
 * transaction-scoped advisory lock so the chain is linear; the table itself rejects UPDATE and
 * DELETE (trigger in migration 0002). `details` must never contain secrets or message content.
 */

const CHAIN_LOCK = 0x61756469; // "audi"
const GENESIS: Buffer = Buffer.alloc(32);

export type AuditDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditEntry {
  readonly actorKind: 'user' | 'system' | 'admin';
  readonly actorId: string | null;
  readonly action: string;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly requestId?: string;
  readonly details?: AuditDetails;
}

type Executor = Kysely<Database> | Transaction<Database>;

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

function rowHash(prev: Buffer, row: Record<string, unknown>): Buffer {
  return sha256(Buffer.concat([prev, Buffer.from(canonical(row), 'utf8')]));
}

export class AuditLog {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /**
   * Appends an entry. Pass the caller's transaction so the audit record commits atomically with
   * the change it describes.
   */
  async record(entry: AuditEntry, executor?: Transaction<Database>): Promise<void> {
    if (executor === undefined) {
      await this.#db.transaction().execute((trx) => this.#append(trx, entry));
      return;
    }
    await this.#append(executor, entry);
  }

  async #append(trx: Executor, entry: AuditEntry): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`.execute(trx);
    const last = await trx
      .selectFrom('audit_log')
      .select('hash')
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const prevHash = last?.hash ?? GENESIS;
    const row = {
      id: newId(),
      at: new Date().toISOString(),
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      requestId: entry.requestId ?? null,
      details: canonical({ ...(entry.details ?? {}) }),
    };
    await trx
      .insertInto('audit_log')
      .values({
        id: row.id,
        at: new Date(row.at),
        actor_kind: row.actorKind,
        actor_id: row.actorId,
        action: row.action,
        target_kind: row.targetKind,
        target_id: row.targetId,
        request_id: row.requestId,
        details: row.details,
        prev_hash: prevHash,
        hash: rowHash(prevHash, row),
      })
      .execute();
  }

  /** Recomputes the chain; returns the seq of the first broken row, or null if intact. */
  async verifyChain(): Promise<string | null> {
    const rows = await this.#db.selectFrom('audit_log').selectAll().orderBy('seq').execute();
    let prev: Buffer = GENESIS;
    for (const row of rows) {
      const expected = rowHash(prev, {
        id: row.id,
        at: row.at.toISOString(),
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        action: row.action,
        targetKind: row.target_kind,
        targetId: row.target_id,
        requestId: row.request_id,
        details: canonical((row.details ?? {}) as Record<string, unknown>),
      });
      if (!row.prev_hash.equals(prev) || !row.hash.equals(expected)) return row.seq;
      prev = row.hash;
    }
    return null;
  }
}
