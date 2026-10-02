/**
 * Typed RPC contract between the main thread and the crypto worker (ADR-006). The main thread
 * never holds private keys or MLS state: it sends plaintext in and gets ciphertext out, and vice
 * versa. Byte strings cross as base64.
 */

export interface Identity {
  readonly userId: string;
  readonly deviceId: string;
  /** null while the device waits to be linked or restored. */
  readonly askPublicKey: string | null;
  readonly askVersion: number;
  readonly certificate: string | null;
  /** Holds the account identity key (can link devices, back up). */
  readonly trusted: boolean;
  /** Waiting to be linked from another device or restored from a backup. */
  readonly pending: boolean;
  /** Has the Backup Root Key (backups are set up). */
  readonly backups: boolean;
}

/** Decrypted history of every conversation, for device-to-device transfer and backups. */
export interface HistoryBundle {
  readonly v: 1;
  readonly conversations: Record<string, HistoryRecord[]>;
}

export interface EncryptedBackup {
  readonly blob: string;
  readonly manifest: string;
  readonly mac: string;
}

/** What decrypting an attachment needs; travels inside the MLS message (crypto-core media.rs). */
export interface MediaDigest {
  readonly key: string;
  readonly plaintextSha256: string;
  readonly ciphertextSha256: string;
  readonly plaintextSize: number;
  readonly ciphertextSize: number;
}

export interface Pin {
  readonly key: string;
  readonly version: number;
  readonly verified: boolean;
  readonly changed: boolean;
}

export interface DeviceRef {
  readonly userId: string;
  readonly deviceId: string;
}

export interface CommitOutput {
  readonly commit: string;
  readonly welcome: string | null;
  readonly welcomeTargets: readonly DeviceRef[];
  readonly epoch: number;
}

/** A decrypted message as persisted in the device's encrypted history. */
export interface HistoryRecord {
  readonly seq: number;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly serverTime: string;
  readonly clientMessageId: string;
  /** Application content (JSON text), or null when it could not be decrypted. */
  readonly content: string | null;
}

export interface InboundMessage {
  readonly seq: number;
  readonly kind: 'application' | 'commit';
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly serverTime: string;
  readonly clientMessageId: string;
  readonly ciphertext: string;
}

export type IngestResult =
  | { readonly status: 'application'; readonly record: HistoryRecord }
  | { readonly status: 'commit'; readonly epoch: number; readonly removedSelf: boolean }
  /** Our own message echoed back (we stored it when sending). */
  | { readonly status: 'own' }
  /** Already processed, a replay, or from before this device joined. */
  | { readonly status: 'duplicate' }
  /** Could not be decrypted or failed verification; a placeholder was stored. */
  | { readonly status: 'undecryptable'; readonly reason: string; readonly record: HistoryRecord }
  /** No group yet (waiting for a Welcome): nothing was processed or stored. */
  | { readonly status: 'no-group' };

export interface SafetyNumber {
  readonly digits: string;
  readonly qr: string;
}

export type IdentityObservation = 'new' | 'unchanged' | 'changed';

/** Every method the worker exposes, with parameters and results. */
export interface CryptoApi {
  init(userId: string): { identity: Identity | null };
  createIdentity(userId: string, askVersion: number): Identity;
  keyPackages(count: number, lastResort: boolean): string[];
  observeIdentity(userId: string, publicKey: string, version: number): IdentityObservation;
  pin(userId: string): Pin | null;
  setVerified(userId: string, verified: boolean): void;
  acknowledgeChange(userId: string): void;
  safetyNumber(userId: string): SafetyNumber;
  qrMatches(userId: string, scanned: string): boolean;
  group(conversationId: string): { exists: boolean; epoch: number; members: DeviceRef[] };
  createGroup(conversationId: string, keyPackages: string[], allowed: string[]): CommitOutput;
  mergePending(conversationId: string): number;
  clearPending(conversationId: string): void;
  discardGroup(conversationId: string): void;
  /** Discards the group only if it is still unconfirmed (epoch 0), in one step. */
  abandonUnconfirmed(conversationId: string): boolean;
  join(conversationId: string, welcome: string, allowed: string[], commitSeq: number): number;
  encrypt(conversationId: string, content: string): { ciphertext: string; epoch: number };
  ingest(conversationId: string, message: InboundMessage, allowed: string[]): IngestResult;
  recordOwn(conversationId: string, record: HistoryRecord): void;
  history(conversationId: string): HistoryRecord[];
  cursor(conversationId: string): number;
  updateMembers(
    conversationId: string,
    keyPackages: string[],
    remove: [string, string][],
    allowed: string[],
  ): CommitOutput;
  needsUpdate(conversationId: string): boolean;
  selfUpdate(conversationId: string): CommitOutput;

  // ---- multi-device (docs/multi-device.md) ----
  /** Deletes all local encryption data for this account on this device and starts over. */
  reset(userId: string): void;
  createPending(userId: string): Identity;
  linkRequest(): { hpkePublic: string; signaturePublic: string };
  linkCode(shortId: string): string;
  parseLinkCode(code: string): string;
  /** Throws unless the keys match the code (fingerprint); see link.rs. */
  verifyLinkCode(code: string, shortId: string, hpkePublic: string, signaturePublic: string): void;
  approveLink(
    code: string,
    shortId: string,
    deviceId: string,
    hpkePublic: string,
    signaturePublic: string,
    trusted: boolean,
    includeHistory: boolean,
  ): string;
  completeLink(sealed: string, shortId: string, expectedAsk: string, version: number): Identity;
  observeDevices(userId: string, deviceIds: string[]): string[];

  // ---- attachments (docs/media.md); these run outside the MLS call queue ----
  /** Encrypts a file under a fresh key; the ciphertext is what gets uploaded. */
  mediaEncrypt(file: Blob): { ciphertext: Blob; digest: MediaDigest };
  /** Decrypts and verifies against the message's digest; nothing is returned on mismatch. */
  mediaDecrypt(ciphertext: Blob, digest: MediaDigest, type: string): Blob;
  mediaCached(blobId: string): Blob | null;
  mediaCache(blobId: string, ciphertext: Blob): void;

  // ---- backups (docs/encrypted-backups.md) ----
  backupEnable(): { recoveryKey: string; wrap: string };
  backupNewRecoveryKey(): { recoveryKey: string; wrap: string };
  backupPasskeyWrap(prfOutput: string): string;
  /** Whether a stored backup was made with this device's backup key (see ADR-042). */
  backupOwns(manifest: string, mac: string): boolean;
  backupExport(version: number): EncryptedBackup;
  backupRestore(
    kind: 'recovery' | 'passkey',
    secret: string,
    wrap: string,
    backup: EncryptedBackup,
    expectedAsk: string,
    version: number,
  ): { identity: Identity; version: number; createdAt: number };
}

export type Method = keyof CryptoApi;

export interface RpcRequest {
  readonly id: number;
  readonly method: Method;
  readonly params: unknown[];
}

export type RpcResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly code: string; readonly message: string };
