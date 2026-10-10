import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  convertCertBufferToPEM,
  decodeAttestationObject,
  getCertificateInfo,
  validateCertificatePath,
} from '@simplewebauthn/server/helpers';
import { AppError } from '@tessera/platform';
import { newId } from '@tessera/shared';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';
import type { ChallengeStore } from '../auth/index.js';

/**
 * Staff security keys (docs/admin.md §1: hardware-backed WebAuthn required), verified by
 * @simplewebauthn/server. Policy: user verification required; only **single-device** credentials
 * (not synced passkeys, which can be copied between devices); when an allow-list of key models
 * (AAGUIDs) is configured, the key must present a `packed` attestation whose certificate chains
 * to a configured vendor root (the library checks the certificate's AAGUID extension matches),
 * for one of the listed models. Without a list, the single-device flags are the authenticator's
 * own claim (docs/admin.md §1 notes this).
 */

export interface AdminKeyConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  /** Lower-case AAGUIDs; empty = any single-device key. */
  readonly aaguids: readonly string[];
  /** Vendor attestation roots (PEM), required when `aaguids` is not empty. */
  readonly attestationRoots: readonly string[];
}

const MAX_KEYS = 5;
const FIDO_AAGUID_EXTENSION = '1.3.6.1.4.1.45724.1.1.4';

export class AdminKeys {
  readonly #db: Kysely<Database>;
  readonly #challenges: ChallengeStore;
  readonly #config: AdminKeyConfig;

  constructor(db: Kysely<Database>, challenges: ChallengeStore, config: AdminKeyConfig) {
    this.#db = db;
    this.#challenges = challenges;
    this.#config = config;
  }

  async count(adminId: string): Promise<number> {
    const rows = await this.#db
      .selectFrom('admin_credentials')
      .select('id')
      .where('admin_id', '=', adminId)
      .execute();
    return rows.length;
  }

  /** The key proves its model: a vendor-signed attestation for a listed AAGUID. */
  async #approvedModel(
    info: { fmt: string; attestationObject: Parameters<typeof decodeAttestationObject>[0] },
    aaguid: string,
  ): Promise<boolean> {
    if (info.fmt !== 'packed' || !this.#config.aaguids.includes(aaguid)) return false;
    if (this.#config.attestationRoots.length === 0) return false;
    const x5c = decodeAttestationObject(info.attestationObject).get('attStmt').get('x5c');
    const leaf = x5c?.[0];
    if (x5c === undefined || leaf === undefined) return false; // self attestation proves nothing
    // The model must be named in the vendor certificate itself (id-fido-gen-ce-aaguid); the
    // library has already checked it equals the AAGUID the key reported.
    const extensions = getCertificateInfo(leaf).parsedCertificate.tbsCertificate.extensions ?? [];
    if (!extensions.some((extension) => extension.extnID === FIDO_AAGUID_EXTENSION)) return false;
    return validateCertificatePath(x5c.map(convertCertBufferToPEM), [
      ...this.#config.attestationRoots,
    ]).catch(() => false);
  }

  async registrationOptions(
    admin: { id: string; email: string },
    sessionId: string,
  ): Promise<{ flowId: string; options: unknown }> {
    const existing = await this.#db
      .selectFrom('admin_credentials')
      .select(['credential_id', 'transports'])
      .where('admin_id', '=', admin.id)
      .execute();
    if (existing.length >= MAX_KEYS)
      throw new AppError('CONFLICT', { detail: 'You have registered the maximum number of keys.' });
    const options = await generateRegistrationOptions({
      rpName: this.#config.rpName,
      rpID: this.#config.rpId,
      userName: admin.email,
      userID: Buffer.from(admin.id.replaceAll('-', ''), 'hex'),
      attestationType: 'direct',
      excludeCredentials: existing.map((row) => ({
        id: row.credential_id.toString('base64url'),
        transports: row.transports as never,
      })),
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
        authenticatorAttachment: 'cross-platform',
      },
    });
    const flowId = await this.#challenges.put({
      kind: 'register',
      challenge: options.challenge,
      userId: admin.id,
      sessionId,
    });
    return { flowId, options };
  }

  async register(
    flowId: string,
    expected: { adminId: string; sessionId: string },
    name: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const flow = await this.#challenges.take(flowId);
    if (
      flow?.kind !== 'register' ||
      flow.userId !== expected.adminId ||
      flow.sessionId !== expected.sessionId
    )
      throw new AppError('INVALID_CREDENTIALS');
    const verification = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: [...this.#config.origins],
      expectedRPID: this.#config.rpId,
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!verification.verified) throw new AppError('INVALID_CREDENTIALS');
    const info = verification.registrationInfo;
    // Synced passkeys are copies that can leave the device: not acceptable for staff.
    if (info.credentialDeviceType !== 'singleDevice' || info.credentialBackedUp)
      throw new AppError('FORBIDDEN', {
        detail:
          'Use a hardware security key. Synced passkeys cannot be used for the admin console.',
      });
    const aaguid = info.aaguid.toLowerCase();
    if (this.#config.aaguids.length > 0 && !(await this.#approvedModel(info, aaguid)))
      throw new AppError('FORBIDDEN', { detail: 'This security key model is not approved.' });
    try {
      await this.#db
        .insertInto('admin_credentials')
        .values({
          id: newId(),
          admin_id: expected.adminId,
          credential_id: Buffer.from(info.credential.id, 'base64url'),
          public_key: Buffer.from(info.credential.publicKey),
          sign_count: info.credential.counter,
          transports: info.credential.transports ?? [],
          aaguid,
          name,
        })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('CONFLICT', { detail: 'This key is already registered.' });
      throw error;
    }
  }

  async authenticationOptions(
    adminId: string,
    sessionId: string,
    purpose: 'login' | 'reauth',
  ): Promise<{ flowId: string; options: unknown }> {
    const keys = await this.#db
      .selectFrom('admin_credentials')
      .select(['credential_id', 'transports'])
      .where('admin_id', '=', adminId)
      .execute();
    if (keys.length === 0)
      throw new AppError('CONFLICT', { detail: 'Register a security key first.' });
    const options = await generateAuthenticationOptions({
      rpID: this.#config.rpId,
      userVerification: 'required',
      allowCredentials: keys.map((row) => ({
        id: row.credential_id.toString('base64url'),
        transports: row.transports as never,
      })),
    });
    const flowId = await this.#challenges.put({
      kind: purpose,
      challenge: options.challenge,
      userId: adminId,
      sessionId,
    });
    return { flowId, options };
  }

  async authenticate(
    flowId: string,
    purpose: 'login' | 'reauth',
    expected: { adminId: string; sessionId: string },
    response: Record<string, unknown>,
  ): Promise<void> {
    const flow = await this.#challenges.take(flowId);
    if (
      flow?.kind !== purpose ||
      flow.userId !== expected.adminId ||
      flow.sessionId !== expected.sessionId
    )
      throw new AppError('INVALID_CREDENTIALS');
    const credentialId = typeof response['id'] === 'string' ? response['id'] : '';
    const key = await this.#db
      .selectFrom('admin_credentials')
      .selectAll()
      .where('credential_id', '=', Buffer.from(credentialId, 'base64url'))
      .where('admin_id', '=', expected.adminId)
      .executeTakeFirst();
    if (key === undefined) throw new AppError('INVALID_CREDENTIALS');
    const verification = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: [...this.#config.origins],
      expectedRPID: this.#config.rpId,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(key.public_key),
        counter: Number(key.sign_count),
        transports: key.transports,
      },
    }).catch(() => null);
    if (!verification?.verified) throw new AppError('INVALID_CREDENTIALS');
    await this.#db
      .updateTable('admin_credentials')
      .set({ sign_count: verification.authenticationInfo.newCounter, last_used_at: new Date() })
      .where('id', '=', key.id)
      .execute();
  }
}
