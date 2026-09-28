import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import type { RegisterDevice, UserKeys } from '@tessera/validation';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';
import type { RealtimePublisher } from '../../platform/realtime-publisher.js';
import type { AuditLog } from '../audit/index.js';

import { parseCertificate, verifyCertificate } from './certificate.js';

/**
 * Key directory (docs/crypto-design.md §3–4, ADR-007). Stores **public** material only:
 * Account Signing Keys, device certificates and MLS KeyPackages. It cannot create or vouch for
 * devices: clients accept a device only if its certificate verifies under the ASK they pinned,
 * so the directory's worst case is withholding or replaying data, which clients detect as
 * missing devices or key changes.
 */

export interface KeysContacts {
  /** Users who share a conversation with `userId` (may fetch its keys; are told about changes). */
  contactsOf(userId: string): Promise<string[]>;
  sharesConversation(userA: string, userB: string): Promise<boolean>;
}

export interface OwnKeys {
  askVersion: number | null;
  askPublicKey: string | null;
  devices: { deviceId: string; certificate: string; createdAt: string }[];
}

const DAY_MS = 24 * 60 * 60_000;
const KEY_PACKAGE_LIFETIME_MS = 30 * DAY_MS;
/** One-time KeyPackages stored per device at most (crypto-design §4 keeps ~100). */
const MAX_STORED_KEY_PACKAGES = 200;

type Executor = Kysely<Database> | Transaction<Database>;

export class KeysService {
  readonly #db: Kysely<Database>;
  readonly #audit: AuditLog;
  readonly #publisher: RealtimePublisher;
  readonly #contacts: KeysContacts;
  readonly #logger: Logger;

  constructor(
    db: Kysely<Database>,
    audit: AuditLog,
    publisher: RealtimePublisher,
    contacts: KeysContacts,
    logger: Logger,
  ) {
    this.#db = db;
    this.#audit = audit;
    this.#publisher = publisher;
    this.#contacts = contacts;
    this.#logger = logger;
  }

  /** Validates the certificate against the submitted identity; throws BAD_REQUEST otherwise. */
  #checkCertificate(userId: string, input: RegisterDevice) {
    const askPublicKey = Buffer.from(input.askPublicKey, 'base64');
    const certificate = parseCertificate(Buffer.from(input.certificate, 'base64'));
    if (
      certificate === null ||
      askPublicKey.length !== 32 ||
      certificate.userId !== userId ||
      certificate.deviceId !== input.deviceId.toLowerCase() ||
      certificate.askVersion !== input.askVersion ||
      !verifyCertificate(certificate, askPublicKey)
    ) {
      throw new AppError('BAD_REQUEST', { detail: 'Invalid device certificate.' });
    }
    return { askPublicKey, certificate };
  }

  /**
   * Sets up encryption for the account's first device (no identity yet) or — with `reset` —
   * replaces the identity: new ASK (version + 1), every previous device revoked. Contacts see a
   * key change and must accept it (docs/e2ee.md §9).
   */
  async registerDevice(
    userId: string,
    input: RegisterDevice,
    options: { reset: boolean; requestId: string },
  ): Promise<OwnKeys> {
    const { askPublicKey, certificate } = this.#checkCertificate(userId, input);
    const now = new Date();
    await this.#db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('account_keys')
        .select(['version', 'public_key'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!options.reset && current !== undefined) {
        throw new AppError('CONFLICT', {
          detail: 'Encryption is already set up for this account on another device.',
        });
      }
      if (options.reset && current === undefined) {
        throw new AppError('CONFLICT', { detail: 'There is no identity to reset.' });
      }
      const expected = current === undefined ? 1 : current.version + 1;
      if (input.askVersion !== expected) {
        throw new AppError('CONFLICT', { detail: 'Identity version changed; try again.' });
      }
      const existingDevice = await trx
        .selectFrom('devices')
        .select('id')
        .where('id', '=', input.deviceId)
        .executeTakeFirst();
      if (existingDevice !== undefined)
        throw new AppError('CONFLICT', { detail: 'Device already registered.' });

      if (current === undefined) {
        await trx
          .insertInto('account_keys')
          .values({ user_id: userId, public_key: askPublicKey, version: expected, updated_at: now })
          .execute();
      } else {
        await trx
          .updateTable('account_keys')
          .set({ public_key: askPublicKey, version: expected, updated_at: now })
          .where('user_id', '=', userId)
          .execute();
        const revoked = await trx
          .updateTable('devices')
          .set({ revoked_at: now })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .returning('id')
          .execute();
        if (revoked.length > 0) {
          await trx
            .deleteFrom('key_packages')
            .where(
              'device_id',
              'in',
              revoked.map((device) => device.id),
            )
            .execute();
        }
      }
      await trx
        .insertInto('devices')
        .values({
          id: input.deviceId,
          user_id: userId,
          ask_version: expected,
          signature_key: certificate.mlsSignatureKey,
          certificate: Buffer.from(input.certificate, 'base64'),
          created_at: now,
          last_seen_at: now,
        })
        .execute();
      await this.#insertKeyPackages(trx, input.deviceId, input.keyPackages, now);
      await this.#replaceLastResort(trx, input.deviceId, input.lastResortKeyPackage, now);
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: options.reset ? 'keys.identity_reset' : 'keys.identity_created',
          targetKind: 'device',
          targetId: input.deviceId,
          requestId: options.requestId,
          details: { askVersion: expected },
        },
        trx,
      );
    });
    if (options.reset) await this.#notifyContacts(userId);
    return this.ownKeys(userId);
  }

  async #notifyContacts(userId: string): Promise<void> {
    const contacts = await this.#contacts.contactsOf(userId);
    this.#publisher.publish([...contacts, userId], { type: 'keys_changed', userId });
  }

  async #insertKeyPackages(
    trx: Executor,
    deviceId: string,
    packages: readonly string[],
    now: Date,
  ): Promise<void> {
    if (packages.length === 0) return;
    await trx
      .insertInto('key_packages')
      .values(
        packages.map((keyPackage) => ({
          id: newId(),
          device_id: deviceId,
          key_package: Buffer.from(keyPackage, 'base64'),
          last_resort: false,
          created_at: now,
          expires_at: new Date(now.getTime() + KEY_PACKAGE_LIFETIME_MS),
        })),
      )
      .execute();
  }

  async #replaceLastResort(trx: Executor, deviceId: string, keyPackage: string, now: Date) {
    await trx
      .deleteFrom('key_packages')
      .where('device_id', '=', deviceId)
      .where('last_resort', '=', true)
      .execute();
    await trx
      .insertInto('key_packages')
      .values({
        id: newId(),
        device_id: deviceId,
        key_package: Buffer.from(keyPackage, 'base64'),
        last_resort: true,
        created_at: now,
        expires_at: new Date(now.getTime() + KEY_PACKAGE_LIFETIME_MS),
      })
      .execute();
  }

  async ownKeys(userId: string): Promise<OwnKeys> {
    const key = await this.#db
      .selectFrom('account_keys')
      .select(['public_key', 'version'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return {
      askVersion: key?.version ?? null,
      askPublicKey: key === undefined ? null : key.public_key.toString('base64'),
      devices: await this.#activeDevices(this.#db, userId),
    };
  }

  async #activeDevices(executor: Executor, userId: string) {
    const rows = await executor
      .selectFrom('devices')
      .select(['id', 'certificate', 'created_at'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      deviceId: row.id,
      certificate: row.certificate.toString('base64'),
      createdAt: row.created_at.toISOString(),
    }));
  }

  /** Callers may read keys of themselves and of users they share a conversation with. */
  async #authorizeRead(callerId: string, targetId: string): Promise<void> {
    if (callerId === targetId) return;
    if (!(await this.#contacts.sharesConversation(callerId, targetId)))
      throw new AppError('NOT_FOUND');
  }

  async userKeys(callerId: string, targetId: string): Promise<UserKeys> {
    await this.#authorizeRead(callerId, targetId);
    const key = await this.#db
      .selectFrom('account_keys')
      .select(['public_key', 'version'])
      .where('user_id', '=', targetId)
      .executeTakeFirst();
    // No identity yet: indistinguishable from "not found" for the caller's purposes.
    if (key === undefined) throw new AppError('NOT_FOUND', { detail: 'No encryption keys yet.' });
    return {
      userId: targetId,
      askPublicKey: key.public_key.toString('base64'),
      askVersion: key.version,
      devices: await this.#activeDevices(this.#db, targetId),
    };
  }

  async #requireOwnDevice(executor: Executor, userId: string, deviceId: string): Promise<void> {
    const device = await executor
      .selectFrom('devices')
      .select('id')
      .where('id', '=', deviceId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (device === undefined) throw new AppError('NOT_FOUND');
  }

  async uploadKeyPackages(
    userId: string,
    deviceId: string,
    input: { keyPackages: readonly string[]; lastResortKeyPackage?: string | undefined },
  ): Promise<{ oneTime: number; lastResort: boolean }> {
    const now = new Date();
    await this.#db.transaction().execute(async (trx) => {
      await this.#requireOwnDevice(trx, userId, deviceId);
      const stored = await this.#countOneTime(trx, deviceId);
      if (stored + input.keyPackages.length > MAX_STORED_KEY_PACKAGES) {
        throw new AppError('BAD_REQUEST', { detail: 'Too many key packages stored.' });
      }
      await this.#insertKeyPackages(trx, deviceId, input.keyPackages, now);
      if (input.lastResortKeyPackage !== undefined)
        await this.#replaceLastResort(trx, deviceId, input.lastResortKeyPackage, now);
    });
    return this.keyPackageCount(userId, deviceId);
  }

  async #countOneTime(executor: Executor, deviceId: string): Promise<number> {
    const row = await executor
      .selectFrom('key_packages')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('device_id', '=', deviceId)
      .where('last_resort', '=', false)
      .where('expires_at', '>', new Date())
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async keyPackageCount(
    userId: string,
    deviceId: string,
  ): Promise<{ oneTime: number; lastResort: boolean }> {
    await this.#requireOwnDevice(this.#db, userId, deviceId);
    const lastResort = await this.#db
      .selectFrom('key_packages')
      .select('id')
      .where('device_id', '=', deviceId)
      .where('last_resort', '=', true)
      .executeTakeFirst();
    return {
      oneTime: await this.#countOneTime(this.#db, deviceId),
      lastResort: lastResort !== undefined,
    };
  }

  /**
   * Claims one KeyPackage for each active device of `targetId` (crypto-design §4): a one-time
   * package is consumed atomically (`FOR UPDATE SKIP LOCKED`, so concurrent claimers never get
   * the same one); when none remain the last-resort package is returned and kept.
   */
  async claim(
    callerId: string,
    targetId: string,
  ): Promise<{ keyPackages: { deviceId: string; keyPackage: string }[] }> {
    await this.#authorizeRead(callerId, targetId);
    const devices = await this.#db
      .selectFrom('devices')
      .select('id')
      .where('user_id', '=', targetId)
      .where('revoked_at', 'is', null)
      .execute();
    const keyPackages: { deviceId: string; keyPackage: string }[] = [];
    for (const device of devices) {
      const claimed = await sql<{ key_package: Buffer }>`
        DELETE FROM key_packages WHERE id = (
          SELECT id FROM key_packages
          WHERE device_id = ${device.id} AND NOT last_resort AND expires_at > now()
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING key_package`.execute(this.#db);
      let keyPackage = claimed.rows[0]?.key_package;
      if (keyPackage === undefined) {
        const lastResort = await this.#db
          .selectFrom('key_packages')
          .select('key_package')
          .where('device_id', '=', device.id)
          .where('last_resort', '=', true)
          .executeTakeFirst();
        keyPackage = lastResort?.key_package;
        if (keyPackage !== undefined) this.#logger.info('keys.last_resort_claimed', { ok: true });
      }
      if (keyPackage !== undefined)
        keyPackages.push({ deviceId: device.id, keyPackage: keyPackage.toString('base64') });
    }
    return { keyPackages };
  }

  /** Used by messaging: the device exists, belongs to the user and is not revoked. */
  async isActiveDevice(userId: string, deviceId: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom('devices')
      .select('id')
      .where('id', '=', deviceId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Deletes expired KeyPackages. */
  async sweep(): Promise<number> {
    const result = await this.#db
      .deleteFrom('key_packages')
      .where('expires_at', '<=', new Date())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
