import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AppError } from '@tessera/platform';
import { newId } from '@tessera/shared';
import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../../db/schema.js';

import type { ChallengeFlow, ChallengeStore } from './challenges.js';

/**
 * Passkeys via WebAuthn Level 3 (docs/authentication.md §2.2), using @simplewebauthn/server for
 * all protocol verification (origin, RP ID hash, challenge, signature, user verification).
 * Policy: user verification required, discoverable credentials required, attestation `none`.
 */

export interface WebAuthnConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
}

export interface StoredPasskey {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly synced: boolean;
}

type Executor = Kysely<Database> | Transaction<Database>;

const MAX_PASSKEYS_PER_USER = 20;

export class PasskeyService {
  readonly #db: Kysely<Database>;
  readonly #challenges: ChallengeStore;
  readonly #config: WebAuthnConfig;

  constructor(db: Kysely<Database>, challenges: ChallengeStore, config: WebAuthnConfig) {
    this.#db = db;
    this.#challenges = challenges;
    this.#config = config;
  }

  async registrationOptions(
    user: { id: string; username: string },
    sessionId: string,
  ): Promise<{ flowId: string; options: unknown }> {
    const existing = await this.#db
      .selectFrom('passkeys')
      .select(['credential_id', 'transports'])
      .where('user_id', '=', user.id)
      .execute();
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new AppError('CONFLICT', {
        detail: 'You have reached the maximum number of passkeys.',
      });
    }
    const options = await generateRegistrationOptions({
      rpName: this.#config.rpName,
      rpID: this.#config.rpId,
      userName: user.username,
      userID: Buffer.from(user.id.replaceAll('-', ''), 'hex'),
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({
        id: row.credential_id.toString('base64url'),
        transports: row.transports,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const flowId = await this.#challenges.put({
      kind: 'register',
      challenge: options.challenge,
      userId: user.id,
      sessionId,
    });
    return { flowId, options };
  }

  async register(
    flowId: string,
    expected: { userId: string; sessionId: string },
    name: string,
    response: Record<string, unknown>,
    executor: Executor,
  ): Promise<string> {
    const flow = await this.#takeFlow(flowId, 'register');
    if (flow.userId !== expected.userId || flow.sessionId !== expected.sessionId) {
      throw new AppError('INVALID_CREDENTIALS');
    }
    const verification = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: [...this.#config.origins],
      expectedRPID: this.#config.rpId,
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!verification.verified) throw new AppError('INVALID_CREDENTIALS');

    const info = verification.registrationInfo;
    const id = newId();
    try {
      await executor
        .insertInto('passkeys')
        .values({
          id,
          user_id: expected.userId,
          credential_id: Buffer.from(info.credential.id, 'base64url'),
          public_key: Buffer.from(info.credential.publicKey),
          sign_count: info.credential.counter,
          transports: info.credential.transports ?? [],
          backup_eligible: info.credentialDeviceType === 'multiDevice',
          backup_state: info.credentialBackedUp,
          name,
        })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('CONFLICT', { detail: 'This passkey is already registered.' });
      }
      throw error;
    }
    return id;
  }

  async authenticationOptions(
    purpose: 'login' | 'reauth',
    session: { id: string; userId: string } | null,
  ): Promise<{ flowId: string; options: unknown }> {
    // Login uses discoverable credentials (no allow-list → no account enumeration). Re-auth is
    // restricted to the signed-in user's own passkeys.
    const allowCredentials =
      purpose === 'reauth' && session !== null
        ? (
            await this.#db
              .selectFrom('passkeys')
              .select(['credential_id', 'transports'])
              .where('user_id', '=', session.userId)
              .execute()
          ).map((row) => ({
            id: row.credential_id.toString('base64url'),
            transports: row.transports,
          }))
        : undefined;
    const options = await generateAuthenticationOptions({
      rpID: this.#config.rpId,
      userVerification: 'required',
      ...(allowCredentials === undefined ? {} : { allowCredentials }),
    });
    const flowId = await this.#challenges.put({
      kind: purpose,
      challenge: options.challenge,
      userId: session?.userId ?? null,
      sessionId: session?.id ?? null,
    });
    return { flowId, options };
  }

  /** Verifies an assertion and returns the owning user; updates the signature counter. */
  async authenticate(
    flowId: string,
    purpose: 'login' | 'reauth',
    response: Record<string, unknown>,
    expectedSession: { id: string; userId: string } | null,
  ): Promise<{ userId: string; passkeyId: string }> {
    const flow = await this.#takeFlow(flowId, purpose);
    if (purpose === 'reauth' && flow.sessionId !== expectedSession?.id) {
      throw new AppError('INVALID_CREDENTIALS');
    }
    const credentialId = typeof response['id'] === 'string' ? response['id'] : '';
    const passkey = await this.#db
      .selectFrom('passkeys')
      .selectAll()
      .where('credential_id', '=', Buffer.from(credentialId, 'base64url'))
      .executeTakeFirst();
    if (passkey === undefined) throw new AppError('INVALID_CREDENTIALS');
    if (purpose === 'reauth' && passkey.user_id !== expectedSession?.userId) {
      throw new AppError('INVALID_CREDENTIALS');
    }

    const verification = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: [...this.#config.origins],
      expectedRPID: this.#config.rpId,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(passkey.public_key),
        counter: Number(passkey.sign_count),
        transports: passkey.transports,
      },
    }).catch(() => null);
    if (!verification?.verified) throw new AppError('INVALID_CREDENTIALS');

    await this.#db
      .updateTable('passkeys')
      .set({
        sign_count: verification.authenticationInfo.newCounter,
        backup_state: verification.authenticationInfo.credentialBackedUp,
        last_used_at: new Date(),
      })
      .where('id', '=', passkey.id)
      .execute();
    return { userId: passkey.user_id, passkeyId: passkey.id };
  }

  async list(userId: string): Promise<StoredPasskey[]> {
    const rows = await this.#db
      .selectFrom('passkeys')
      .select(['id', 'name', 'created_at', 'last_used_at', 'backup_state'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      synced: row.backup_state,
    }));
  }

  async count(userId: string, executor: Executor = this.#db): Promise<number> {
    const row = await executor
      .selectFrom('passkeys')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async remove(userId: string, passkeyId: string, executor: Executor): Promise<boolean> {
    const result = await executor
      .deleteFrom('passkeys')
      .where('id', '=', passkeyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async #takeFlow(flowId: string, kind: ChallengeFlow['kind']): Promise<ChallengeFlow> {
    const flow = await this.#challenges.take(flowId);
    if (flow?.kind !== kind) throw new AppError('INVALID_CREDENTIALS');
    return flow;
  }
}
