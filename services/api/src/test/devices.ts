import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

import { newId } from '@tessera/shared';

import type { TestClient } from './integration-app.js';

/**
 * Test double for a client device: an Ed25519 Account Signing Key and a correctly signed device
 * certificate in the exact layout of packages/crypto-core/src/identity.rs. KeyPackages are opaque
 * to the server, so random bytes stand in for them.
 */

const CONTEXT = Buffer.from('tessera-device-cert-v1', 'utf8');

export interface TestIdentity {
  readonly askPublicKey: Buffer;
  readonly askPrivateKey: KeyObject;
  readonly askVersion: number;
}

export function newIdentity(askVersion = 1): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    askPublicKey: Buffer.from(jwk.x ?? '', 'base64url'),
    askPrivateKey: privateKey,
    askVersion,
  };
}

function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replaceAll('-', ''), 'hex');
}

export function certificate(
  identity: TestIdentity,
  userId: string,
  deviceId: string,
  overrides: { askVersion?: number; signWith?: KeyObject } = {},
): Buffer {
  const askVersion = Buffer.alloc(4);
  askVersion.writeUInt32BE(overrides.askVersion ?? identity.askVersion);
  const createdAt = Buffer.alloc(8);
  createdAt.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const body = Buffer.concat([
    Buffer.from([1]),
    uuidBytes(userId),
    uuidBytes(deviceId),
    randomBytes(32),
    askVersion,
    createdAt,
    Buffer.from([1, 0x00, 0x01]),
  ]);
  const signature = sign(
    null,
    Buffer.concat([CONTEXT, body]),
    overrides.signWith ?? identity.askPrivateKey,
  );
  return Buffer.concat([body, signature]);
}

export const keyPackage = (): string => randomBytes(300).toString('base64');

export function registration(
  identity: TestIdentity,
  userId: string,
  deviceId: string = newId(),
  keyPackages = 3,
) {
  return {
    askPublicKey: identity.askPublicKey.toString('base64'),
    askVersion: identity.askVersion,
    deviceId,
    certificate: certificate(identity, userId, deviceId).toString('base64'),
    keyPackages: Array.from({ length: keyPackages }, keyPackage),
    lastResortKeyPackage: keyPackage(),
  };
}

/** Registers a first device for the signed-in user; returns its id. */
export async function registerDevice(client: TestClient, userId: string): Promise<string> {
  const body = registration(newIdentity(), userId);
  const response = await client.post('/api/v1/keys/devices', body);
  if (response.statusCode !== 201) throw new Error(`device registration failed: ${response.body}`);
  return body.deviceId;
}
