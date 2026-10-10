import { randomBytes } from 'node:crypto';

import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  MAX_DEVICES,
  type RegisterDevice,
  type UserKeys,
  type linkRequestSchema,
} from '@tessera/validation';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { z } from 'zod';

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
  devices: {
    deviceId: string;
    certificate: string;
    createdAt: string;
    label: string;
    trusted: boolean;
    lastSeenAt: string;
  }[];
}

/** Security emails for key events (sent by the auth module). */
export interface KeysNotifier {
  securityNotice(userId: string, headline: string, lines?: readonly string[]): Promise<void>;
}

export interface AddDevice {
  deviceId: string;
  askVersion: number;
  certificate: string;
  keyPackages: readonly string[];
  lastResortKeyPackage: string;
  label: string;
  trusted: boolean;
}

const LINK_TTL_MS = 3 * 60_000;
const MAX_PENDING_LINKS = 3;

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
  #notifier: KeysNotifier | null = null;

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

  useNotifier(notifier: KeysNotifier): void {
    this.#notifier = notifier;
  }

  async #notify(userId: string, headline: string, lines: readonly string[] = []): Promise<void> {
    await this.#notifier?.securityNotice(userId, headline, lines).catch(() => undefined);
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
          label: input.label ?? 'Unknown device',
          trusted: true,
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
    if (options.reset) {
      await this.#notifyContacts(userId);
      await this.#notify(userId, 'Your security key was replaced', [
        'All your other devices were signed out of encrypted chats.',
        'Your contacts will see that your security key changed.',
      ]);
    }
    return this.ownKeys(userId);
  }

  /**
   * Adds a device to the account's *current* identity (linked from another device, or restored
   * from a backup). The certificate must verify under the current identity key: only a device
   * holding that key can produce it, so this is the approval.
   */
  async addDevice(userId: string, input: AddDevice, requestId: string): Promise<OwnKeys> {
    const certificate = parseCertificate(Buffer.from(input.certificate, 'base64'));
    const now = new Date();
    await this.#db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('account_keys')
        .select(['version', 'public_key'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined)
        throw new AppError('CONFLICT', { detail: 'Set up encryption first.' });
      if (
        certificate?.userId !== userId ||
        certificate.deviceId !== input.deviceId.toLowerCase() ||
        certificate.askVersion !== current.version ||
        input.askVersion !== current.version ||
        !verifyCertificate(certificate, current.public_key)
      ) {
        throw new AppError('BAD_REQUEST', { detail: 'Invalid device certificate.' });
      }
      const active = await trx
        .selectFrom('devices')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(active.n) >= MAX_DEVICES)
        throw new AppError('CONFLICT', {
          detail: `You can use encryption on up to ${MAX_DEVICES} devices. Remove one first.`,
        });
      const existing = await trx
        .selectFrom('devices')
        .select('id')
        .where('id', '=', input.deviceId)
        .executeTakeFirst();
      if (existing !== undefined)
        throw new AppError('CONFLICT', { detail: 'Device already registered.' });
      await trx
        .insertInto('devices')
        .values({
          id: input.deviceId,
          user_id: userId,
          ask_version: current.version,
          signature_key: certificate.mlsSignatureKey,
          certificate: Buffer.from(input.certificate, 'base64'),
          created_at: now,
          last_seen_at: now,
          label: input.label,
          trusted: input.trusted,
        })
        .execute();
      await this.#insertKeyPackages(trx, input.deviceId, input.keyPackages, now);
      await this.#replaceLastResort(trx, input.deviceId, input.lastResortKeyPackage, now);
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'keys.device_added',
          targetKind: 'device',
          targetId: input.deviceId,
          requestId,
          details: { trusted: input.trusted },
        },
        trx,
      );
    });
    await this.#notifyContacts(userId);
    await this.#notify(userId, 'A new device can now read your messages', [
      `Device: ${input.label}`,
      'If this was not you, remove the device in Settings → Security and change your password.',
    ]);
    return this.ownKeys(userId);
  }

  /** Revokes one device: it can no longer receive new messages; contacts remove it from groups. */
  async revokeDevice(userId: string, deviceId: string, requestId: string): Promise<OwnKeys> {
    const now = new Date();
    const label = await this.#db.transaction().execute(async (trx) => {
      const device = await trx
        .updateTable('devices')
        .set({ revoked_at: now })
        .where('id', '=', deviceId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning('label')
        .executeTakeFirst();
      if (device === undefined) throw new AppError('NOT_FOUND');
      await trx.deleteFrom('key_packages').where('device_id', '=', deviceId).execute();
      await this.#audit.record(
        {
          actorKind: 'user',
          actorId: userId,
          action: 'keys.device_revoked',
          targetKind: 'device',
          targetId: deviceId,
          requestId,
        },
        trx,
      );
      return device.label;
    });
    await this.#notifyContacts(userId);
    await this.#notify(userId, 'A device was removed from your encrypted chats', [
      `Device: ${label}`,
    ]);
    return this.ownKeys(userId);
  }

  // ---- device linking (docs/multi-device.md §3) --------------------------------------------

  async createLink(
    userId: string,
    sessionId: string,
    input: { deviceId: string; hpkePublic: string; signaturePublic: string; label: string },
  ): Promise<{ linkId: string; shortId: string; expiresAt: string }> {
    const now = new Date();
    const pending = await this.#db
      .selectFrom('link_sessions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('expires_at', '>', now)
      .executeTakeFirstOrThrow();
    if (Number(pending.n) >= MAX_PENDING_LINKS)
      throw new AppError('RATE_LIMITED', { detail: 'Too many devices waiting to be linked.' });
    const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newId();
      const shortId = randomBytes(5);
      try {
        await this.#db
          .insertInto('link_sessions')
          .values({
            id,
            user_id: userId,
            session_id: sessionId,
            short_id: shortId,
            device_id: input.deviceId,
            hpke_public: Buffer.from(input.hpkePublic, 'base64'),
            signature_public: Buffer.from(input.signaturePublic, 'base64'),
            label: input.label,
            created_at: now,
            expires_at: expiresAt,
          })
          .execute();
        return {
          linkId: id,
          shortId: shortId.toString('base64'),
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
      }
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  /** An existing device looks up a link request by the short id from the code. */
  async lookupLink(userId: string, shortId: string): Promise<z.infer<typeof linkRequestSchema>> {
    const row = await this.#db
      .selectFrom('link_sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('short_id', '=', Buffer.from(shortId, 'base64url'))
      .where('expires_at', '>', new Date())
      .where('sealed', 'is', null)
      .executeTakeFirst();
    if (row === undefined)
      throw new AppError('NOT_FOUND', { detail: 'That code has expired or is not valid.' });
    return {
      linkId: row.id,
      deviceId: row.device_id,
      hpkePublic: row.hpke_public.toString('base64'),
      signaturePublic: row.signature_public.toString('base64'),
      label: row.label,
      createdAt: row.created_at.toISOString(),
    };
  }

  async approveLink(
    userId: string,
    linkId: string,
    input: { approverDeviceId: string; sealed: string },
  ): Promise<void> {
    if (!(await this.isActiveDevice(userId, input.approverDeviceId)))
      throw new AppError('FORBIDDEN', { detail: 'This device is not registered for encryption.' });
    const updated = await this.#db
      .updateTable('link_sessions')
      .set({ sealed: Buffer.from(input.sealed, 'base64'), approved_by: input.approverDeviceId })
      .where('id', '=', linkId)
      .where('user_id', '=', userId)
      .where('sealed', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0)
      throw new AppError('NOT_FOUND', { detail: 'That link request has expired.' });
    this.#publisher.publish([userId], { type: 'link_approved', linkId });
  }

  /** The waiting device polls its link; the sealed payload is handed out once. */
  async linkStatus(
    userId: string,
    sessionId: string,
    linkId: string,
  ): Promise<{ status: 'pending' | 'approved'; sealed: string | null }> {
    const row = await this.#db
      .selectFrom('link_sessions')
      .select(['sealed', 'expires_at'])
      .where('id', '=', linkId)
      .where('user_id', '=', userId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    if (row.sealed === null) {
      if (row.expires_at <= new Date()) throw new AppError('NOT_FOUND', { detail: 'Expired.' });
      return { status: 'pending', sealed: null };
    }
    await this.#db.deleteFrom('link_sessions').where('id', '=', linkId).execute();
    return { status: 'approved', sealed: row.sealed.toString('base64') };
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
      .select(['id', 'certificate', 'created_at', 'label', 'trusted', 'last_seen_at'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      deviceId: row.id,
      certificate: row.certificate.toString('base64'),
      createdAt: row.created_at.toISOString(),
      label: row.label,
      trusted: row.trusted,
      lastSeenAt: row.last_seen_at.toISOString(),
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
      // Contacts see certificates only, not labels or activity.
      devices: (await this.#activeDevices(this.#db, targetId)).map((device) => ({
        deviceId: device.deviceId,
        certificate: device.certificate,
        createdAt: device.createdAt,
      })),
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

  /** The ids among `deviceIds` that are not revoked (used by notifications). */
  async activeDeviceIds(deviceIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(deviceIds)];
    if (ids.length === 0) return new Set();
    const rows = await this.#db
      .selectFrom('devices')
      .select('id')
      .where('id', 'in', ids)
      .where('revoked_at', 'is', null)
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  /** Deletes expired KeyPackages and link requests. */
  async sweep(): Promise<number> {
    const now = new Date();
    const packages = await this.#db
      .deleteFrom('key_packages')
      .where('expires_at', '<=', now)
      .executeTakeFirst();
    const links = await this.#db
      .deleteFrom('link_sessions')
      .where('expires_at', '<=', new Date(now.getTime() - LINK_TTL_MS))
      .executeTakeFirst();
    return Number(packages.numDeletedRows) + Number(links.numDeletedRows);
  }
}
