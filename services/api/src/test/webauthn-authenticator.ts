import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Software WebAuthn authenticator for tests: produces genuine attestation (`none`, or `packed`
 * with a test vendor certificate) and
 * assertion structures signed with a real P-256 key, so the server-side library performs its
 * full verification. Test-only — never shipped.
 */

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const head = Buffer.alloc(3);
  head[0] = (major << 5) | 25;
  head.writeUInt16BE(length, 1);
  return head;
}

type Cbor = number | string | Buffer | Cbor[] | Map<number | string, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  const parts = [cborHead(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

export interface SoftwareAuthenticatorOptions {
  readonly rpId: string;
  readonly origin: string;
  readonly userVerified?: boolean;
  /** A security key: single-device (no backup flags), with this model id (AAGUID). */
  readonly hardwareBound?: { readonly aaguid: Buffer };
  /**
   * A `packed` attestation signed by this certificate's key (leaf first, DER), as a vendor's
   * security key makes it; otherwise the attestation format is `none`.
   */
  readonly attestation?:
    { readonly certificates: readonly Buffer[]; readonly key: KeyObject } | 'self';
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #counter = 0;
  #userHandle = Buffer.alloc(0);

  constructor(readonly options: SoftwareAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  #flags(attested: boolean, userVerified = this.options.userVerified !== false): number {
    // UP | (UV) | BE | BS | (AT); security keys are not backup-eligible.
    const backup = this.options.hardwareBound === undefined ? 0x08 | 0x10 : 0;
    return 0x01 | (userVerified ? 0x04 : 0) | backup | (attested ? 0x40 : 0);
  }

  #clientData(type: string, challenge: string, origin = this.options.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** Creates a passkey for `PublicKeyCredentialCreationOptionsJSON`. */
  register(
    options: Record<string, unknown>,
    overrides: { origin?: string } = {},
  ): Record<string, unknown> {
    const challenge = String(options['challenge']);
    const user = options['user'] as { id: string };
    this.#userHandle = Buffer.from(user.id, 'base64url');
    const jwk = this.#publicKey.export({ format: 'jwk' });
    const coseKey = new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x ?? '', 'base64url')],
      [-3, Buffer.from(jwk.y ?? '', 'base64url')],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.#flags(true)]),
      counter,
      this.options.hardwareBound?.aaguid ?? Buffer.alloc(16), // AAGUID
      idLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const clientDataJSON = this.#clientData('webauthn.create', challenge, overrides.origin);
    const attestation = this.options.attestation;
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', attestation === undefined ? 'none' : 'packed'],
        [
          'attStmt',
          attestation === undefined
            ? new Map()
            : new Map<string, Cbor>([
                ['alg', -7],
                [
                  'sig',
                  sign(
                    'sha256',
                    Buffer.concat([authData, sha256(clientDataJSON)]),
                    attestation === 'self' ? this.#privateKey : attestation.key,
                  ),
                ],
                // Self attestation: signed by the credential key itself, no certificate.
                ...(attestation === 'self'
                  ? []
                  : ([['x5c', [...attestation.certificates]]] as [string, Cbor][])),
              ]),
        ],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId.toString('base64url'),
      rawId: this.credentialId.toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Signs an assertion for `PublicKeyCredentialRequestOptionsJSON`. */
  assert(
    options: Record<string, unknown>,
    overrides: { origin?: string; userVerified?: boolean } = {},
  ): Record<string, unknown> {
    this.#counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const authData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.#flags(false, overrides.userVerified)]),
      counter,
    ]);
    const clientDataJSON = this.#clientData(
      'webauthn.get',
      String(options['challenge']),
      overrides.origin,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.#privateKey,
    );
    return {
      id: this.credentialId.toString('base64url'),
      rawId: this.credentialId.toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: this.#userHandle.toString('base64url'),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
