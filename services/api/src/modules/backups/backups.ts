import { AppError } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  BACKUP_VERSIONS_KEPT,
  MAX_BACKUP_BYTES,
  type backupDownloadSchema,
  type backupStatusSchema,
} from '@tessera/validation';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { Database } from '../../db/schema.js';
import type { AuditLog } from '../audit/index.js';

/**
 * Encrypted backups (docs/encrypted-backups.md, ADR-014, ADR-042). The server stores:
 * - backup ciphertext with its MAC-authenticated manifest (it cannot verify the MAC: it does not
 *   hold the key); the last BACKUP_VERSIONS_KEPT versions are kept;
 * - the Backup Root Key wrapped under the user's recovery key or passkey PRF output.
 * Nothing here can decrypt a backup. Adding or removing a way to unlock backups, or turning
 * them off, requires step-up and triggers a security email.
 */

export interface BackupsNotifier {
  securityNotice(userId: string, headline: string, lines?: readonly string[]): Promise<void>;
}

export class BackupsService {
  readonly #db: Kysely<Database>;
  readonly #audit: AuditLog;
  readonly #notifier: BackupsNotifier;

  constructor(db: Kysely<Database>, audit: AuditLog, notifier: BackupsNotifier) {
    this.#db = db;
    this.#audit = audit;
    this.#notifier = notifier;
  }

  async #notify(userId: string, headline: string, lines: readonly string[] = []): Promise<void> {
    await this.#notifier.securityNotice(userId, headline, lines).catch(() => undefined);
  }

  async status(userId: string): Promise<z.infer<typeof backupStatusSchema>> {
    const latest = await this.#db
      .selectFrom('backups')
      .select([
        'version',
        'created_at',
        'manifest',
        'mac',
        (eb) => eb.fn('octet_length', ['blob']).as('size'),
      ])
      .where('user_id', '=', userId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    const wraps = await this.#db
      .selectFrom('backup_wraps')
      .select(['id', 'kind', 'credential_id', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'asc')
      .execute();
    return {
      latest:
        latest === undefined
          ? null
          : {
              version: Number(latest.version),
              createdAt: latest.created_at.toISOString(),
              size: Number(latest.size),
              manifest: latest.manifest,
              mac: latest.mac.toString('base64'),
            },
      wraps: wraps.map((wrap) => ({
        id: wrap.id,
        kind: wrap.kind,
        credentialId: wrap.credential_id,
        createdAt: wrap.created_at.toISOString(),
      })),
    };
  }

  async addWrap(
    userId: string,
    input:
      | { kind: 'recovery'; wrap: string }
      | { kind: 'passkey'; wrap: string; credentialId: string; prfSalt: string },
    requestId: string,
  ): Promise<{ id: string }> {
    const id = newId();
    await this.#db.transaction().execute(async (trx) => {
      if (input.kind === 'recovery') {
        // One recovery key at a time: a new one replaces the old.
        await trx
          .deleteFrom('backup_wraps')
          .where('user_id', '=', userId)
          .where('kind', '=', 'recovery')
          .execute();
      }
      await trx
        .insertInto('backup_wraps')
        .values({
          id,
          user_id: userId,
          kind: input.kind,
          wrap: Buffer.from(input.wrap, 'base64'),
          credential_id: input.kind === 'passkey' ? input.credentialId : null,
          prf_salt: input.kind === 'passkey' ? Buffer.from(input.prfSalt, 'base64') : null,
        })
        .execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'backups.key_added',
          targetKind: 'backup_wrap',
          targetId: id,
          requestId,
          details: { kind: input.kind },
        },
        trx,
      );
    });
    await this.#notify(
      userId,
      input.kind === 'recovery'
        ? 'A new recovery key can unlock your message backups'
        : 'A passkey can now unlock your message backups',
    );
    return { id };
  }

  async deleteWrap(userId: string, id: string, requestId: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom('backup_wraps')
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'backups.key_removed',
          targetKind: 'backup_wrap',
          targetId: id,
          requestId,
        },
        trx,
      );
    });
    await this.#notify(userId, 'A way to unlock your message backups was removed');
  }

  /** Stores the next backup version (must be exactly latest + 1) and prunes old ones. */
  async upload(
    userId: string,
    input: { version: number; manifest: string; mac: string; blob: string },
  ): Promise<{ version: number }> {
    const blob = Buffer.from(input.blob, 'base64');
    if (blob.length === 0 || blob.length > MAX_BACKUP_BYTES)
      throw new AppError('BAD_REQUEST', { detail: 'Backup is empty or too large.' });
    await this.#db.transaction().execute(async (trx) => {
      const wraps = await trx
        .selectFrom('backup_wraps')
        .select('id')
        .where('user_id', '=', userId)
        .limit(1)
        .execute();
      if (wraps.length === 0)
        throw new AppError('CONFLICT', { detail: 'Set up a recovery key before backing up.' });
      const latest = await trx
        .selectFrom('backups')
        .select('version')
        .where('user_id', '=', userId)
        .orderBy('version', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      const expected = latest === undefined ? 1 : Number(latest.version) + 1;
      if (input.version !== expected)
        throw new AppError('CONFLICT', { detail: 'Another device backed up first.' });
      await trx
        .insertInto('backups')
        .values({
          user_id: userId,
          version: input.version,
          blob,
          manifest: input.manifest,
          mac: Buffer.from(input.mac, 'base64'),
        })
        .execute();
      await trx
        .deleteFrom('backups')
        .where('user_id', '=', userId)
        .where('version', '<=', String(input.version - BACKUP_VERSIONS_KEPT))
        .execute();
    });
    return { version: input.version };
  }

  async latest(userId: string): Promise<z.infer<typeof backupDownloadSchema>> {
    const backup = await this.#db
      .selectFrom('backups')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (backup === undefined) throw new AppError('NOT_FOUND', { detail: 'No backup yet.' });
    const wraps = await this.#db
      .selectFrom('backup_wraps')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    return {
      version: Number(backup.version),
      manifest: backup.manifest,
      mac: backup.mac.toString('base64'),
      blob: backup.blob.toString('base64'),
      createdAt: backup.created_at.toISOString(),
      wraps: wraps.map((wrap) => ({
        id: wrap.id,
        kind: wrap.kind,
        wrap: wrap.wrap.toString('base64'),
        credentialId: wrap.credential_id,
        prfSalt: wrap.prf_salt?.toString('base64') ?? null,
      })),
    };
  }

  /** Turns backups off: deletes every stored backup and every way to unlock them. */
  async disable(userId: string, requestId: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await trx.deleteFrom('backups').where('user_id', '=', userId).execute();
      await trx.deleteFrom('backup_wraps').where('user_id', '=', userId).execute();
      await this.#audit.record(
        { actorKind: 'user', actorId: userId, action: 'backups.disabled', requestId },
        trx,
      );
    });
    await this.#notify(userId, 'Message backups were turned off and deleted');
  }
}
