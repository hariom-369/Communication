/**
 * Typed RPC contract between the main thread and the crypto worker (ADR-006). The main thread
 * never holds private keys or MLS state: it sends plaintext in and gets ciphertext out, and vice
 * versa. Byte strings cross as base64.
 */

export interface Identity {
  readonly userId: string;
  readonly deviceId: string;
  readonly askPublicKey: string;
  readonly askVersion: number;
  readonly certificate: string;
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
