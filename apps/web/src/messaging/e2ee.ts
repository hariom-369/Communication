import { newId } from '@tessera/shared';
import type { Conversation, MailboxMessage, RegisterDevice, UserKeys } from '@tessera/validation';

import { ApiError } from '../api/client.js';
import type { endpoints as Endpoints } from '../api/endpoints.js';
import type { AsyncCryptoApi } from '../crypto/client.js';
import { WorkerCryptoError } from '../crypto/client.js';
import type {
  CommitOutput,
  HistoryRecord,
  Identity,
  IngestResult,
  SafetyNumber,
} from '../crypto/protocol.js';

/**
 * End-to-end encryption session for the signed-in user on this device (docs/e2ee.md §5).
 *
 * Orchestration only: every cryptographic operation happens in the crypto worker. This class
 * decides *when* to create groups, join from Welcomes, add or remove devices, and it enforces the
 * user-facing trust rules:
 * - identities are pinned on first use; a changed identity key blocks sending in affected
 *   conversations until the user acknowledges it (docs/e2ee.md §9);
 * - a conversation's MLS group contains exactly the active devices the key directory lists for
 *   its members, and every device must carry a certificate from its user's pinned identity key
 *   (checked inside the worker).
 */

type Api = Pick<
  typeof Endpoints,
  | 'ownKeys'
  | 'userKeys'
  | 'registerDevice'
  | 'resetIdentity'
  | 'keyPackageCount'
  | 'uploadKeyPackages'
  | 'claimKeyPackages'
  | 'commit'
  | 'welcomes'
  | 'ackWelcome'
  | 'conversation'
>;

export type DeviceStatus =
  /** Loading local state. */
  | 'starting'
  | 'ready'
  /** The account has encryption keys on another device; this device has none. */
  | 'setup-required'
  /** This device's keys were replaced (identity reset elsewhere). */
  | 'revoked'
  | 'error';

export interface ConversationSecurity {
  /** Contacts whose identity key changed and who the user has not re-accepted: sending blocked. */
  readonly keyChanged: readonly string[];
  /** Contacts who have verified status (safety number compared). */
  readonly verified: readonly string[];
  /** A contact has not set up encryption yet. */
  readonly peerNotReady: boolean;
  /** Waiting for another member's device to add this one. */
  readonly waitingForWelcome: boolean;
  /** A security check failed; messages may be unreadable. */
  readonly failed: boolean;
}

export const DEFAULT_SECURITY: ConversationSecurity = {
  keyChanged: [],
  verified: [],
  peerNotReady: false,
  waitingForWelcome: false,
  failed: false,
};

/** Sending is not possible right now for a reason the user can see (and possibly resolve). */
export class SecurityBlocked extends Error {
  readonly reason: 'device' | 'key-changed' | 'peer-not-ready' | 'waiting';
  constructor(reason: SecurityBlocked['reason']) {
    super(reason);
    this.reason = reason;
  }
}

const KEY_PACKAGE_BATCH = 100;
const KEY_PACKAGE_LOW = 25;
const KEYS_TTL_MS = 60_000;

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 409;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 404;
}

export type CryptoConnection = AsyncCryptoApi & { close(): void };

export class E2eeSession {
  readonly #connect: () => CryptoConnection;
  #connection: CryptoConnection | null = null;
  readonly #api: Api;
  readonly #me: string;
  readonly #listeners = new Set<() => void>();
  #status: DeviceStatus = 'starting';
  #identity: Identity | null = null;
  readonly #keys = new Map<string, { at: number; keys: UserKeys | null }>();
  readonly #conversations = new Map<string, ConversationSecurity>();
  #welcomes: Promise<string[]> | null = null;
  readonly #preparing = new Map<string, Promise<void>>();

  /** `connect` starts the crypto worker; the session owns it between `start` and `stop`. */
  constructor(connect: () => CryptoConnection, api: Api, me: string) {
    this.#connect = connect;
    this.#api = api;
    this.#me = me;
  }

  get #crypto(): AsyncCryptoApi {
    this.#connection ??= this.#connect();
    return this.#connection;
  }

  /** Stops the crypto worker (keys leave memory). `start` may be called again later. */
  stop(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#identity = null;
    this.#status = 'starting';
  }

  // ---- observation ---------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  get status(): DeviceStatus {
    return this.#status;
  }

  get deviceId(): string | null {
    return this.#identity?.deviceId ?? null;
  }

  security(conversationId: string): ConversationSecurity {
    return this.#conversations.get(conversationId) ?? DEFAULT_SECURITY;
  }

  #update(conversationId: string, change: Partial<ConversationSecurity>): void {
    this.#conversations.set(conversationId, { ...this.security(conversationId), ...change });
    this.#emit();
  }

  #setStatus(status: DeviceStatus): void {
    this.#status = status;
    this.#emit();
  }

  // ---- device lifecycle ------------------------------------------------------------------------

  async start(): Promise<void> {
    try {
      const { identity } = await this.#crypto.init(this.#me);
      const server = await this.#api.ownKeys();
      if (identity === null) {
        if (server.askVersion === null) await this.#register(false);
        else this.#setStatus('setup-required');
        return;
      }
      this.#identity = identity;
      if (server.askVersion === null && identity.askVersion === 1) {
        // Registration did not complete last time: finish it with the same identity.
        await this.#submit(false, identity);
        return;
      }
      const active =
        server.askPublicKey === identity.askPublicKey &&
        server.devices.some((device) => device.deviceId === identity.deviceId);
      if (!active) {
        this.#setStatus('revoked');
        return;
      }
      this.#setStatus('ready');
      await this.#topUp();
    } catch {
      this.#setStatus('error');
    }
  }

  /**
   * Replaces this account's identity with a new one on this device (lost device / keys on
   * another device). Every other device is signed out of encrypted chats and contacts are
   * warned. `withStepUp` runs the request with the re-authentication prompt.
   */
  async resetIdentity(
    withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>,
  ): Promise<boolean> {
    const done = await this.#register(true, withStepUp);
    return done;
  }

  async #register(
    reset: boolean,
    withStepUp?: <T>(action: () => Promise<T>) => Promise<T | undefined>,
  ): Promise<boolean> {
    const server = await this.#api.ownKeys();
    const identity = await this.#crypto.createIdentity(this.#me, (server.askVersion ?? 0) + 1);
    this.#identity = identity;
    return this.#submit(reset, identity, withStepUp);
  }

  async #submit(
    reset: boolean,
    identity: Identity,
    withStepUp?: <T>(action: () => Promise<T>) => Promise<T | undefined>,
  ): Promise<boolean> {
    const keyPackages = await this.#crypto.keyPackages(KEY_PACKAGE_BATCH, false);
    const [lastResort] = await this.#crypto.keyPackages(1, true);
    const body: RegisterDevice = {
      askPublicKey: identity.askPublicKey,
      askVersion: identity.askVersion,
      deviceId: identity.deviceId as RegisterDevice['deviceId'],
      certificate: identity.certificate,
      keyPackages,
      lastResortKeyPackage: lastResort ?? '',
    };
    const request = () => (reset ? this.#api.resetIdentity(body) : this.#api.registerDevice(body));
    const result = withStepUp === undefined ? await request() : await withStepUp(request);
    if (result === undefined) return false;
    this.#keys.clear();
    this.#conversations.clear();
    this.#setStatus('ready');
    return true;
  }

  /** Keeps enough one-time KeyPackages on the server (crypto-design §4). */
  async #topUp(): Promise<void> {
    const deviceId = this.deviceId;
    if (deviceId === null) return;
    const count = await this.#api.keyPackageCount(deviceId);
    if (count.oneTime >= KEY_PACKAGE_LOW && count.lastResort) return;
    const packages =
      count.oneTime >= KEY_PACKAGE_LOW
        ? []
        : await this.#crypto.keyPackages(KEY_PACKAGE_BATCH, false);
    const lastResort = count.lastResort ? undefined : (await this.#crypto.keyPackages(1, true))[0];
    await this.#api.uploadKeyPackages(deviceId, packages, lastResort);
  }

  // ---- identities --------------------------------------------------------------------------

  async #userKeys(userId: string, force = false): Promise<UserKeys | null> {
    const cached = this.#keys.get(userId);
    if (!force && cached !== undefined && Date.now() - cached.at < KEYS_TTL_MS) return cached.keys;
    let keys: UserKeys | null;
    try {
      keys = await this.#api.userKeys(userId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      keys = null;
    }
    this.#keys.set(userId, { at: Date.now(), keys });
    return keys;
  }

  /** Pins (or re-checks) the identity keys of a conversation's other members. */
  async #observe(conversationId: string, peers: readonly string[], force = false): Promise<void> {
    const keyChanged: string[] = [];
    const verified: string[] = [];
    let peerNotReady = false;
    for (const peer of peers) {
      const keys = await this.#userKeys(peer, force);
      if (keys === null) {
        peerNotReady = true;
        continue;
      }
      await this.#crypto.observeIdentity(peer, keys.askPublicKey, keys.askVersion);
      const pin = await this.#crypto.pin(peer);
      if (pin?.changed === true) keyChanged.push(peer);
      if (pin?.verified === true) verified.push(peer);
    }
    this.#update(conversationId, { keyChanged, verified, peerNotReady });
  }

  /** A contact's keys changed (realtime hint): re-fetch before anything else uses them. */
  async keysChanged(userId: string): Promise<void> {
    await this.#userKeys(userId, true);
  }

  async safetyNumber(userId: string): Promise<SafetyNumber> {
    return this.#crypto.safetyNumber(userId);
  }

  async qrMatches(userId: string, scanned: string): Promise<boolean> {
    return this.#crypto.qrMatches(userId, scanned);
  }

  async setVerified(conversationId: string, userId: string, verified: boolean): Promise<void> {
    await this.#crypto.setVerified(userId, verified);
    const current = this.security(conversationId);
    this.#update(conversationId, {
      verified: verified
        ? [...new Set([...current.verified, userId])]
        : current.verified.filter((u) => u !== userId),
      keyChanged: verified ? current.keyChanged.filter((u) => u !== userId) : current.keyChanged,
    });
  }

  /** The user saw the key-change warning and chose to continue. */
  async acknowledgeChange(conversationId: string, userId: string): Promise<void> {
    await this.#crypto.acknowledgeChange(userId);
    const current = this.security(conversationId);
    this.#update(conversationId, { keyChanged: current.keyChanged.filter((u) => u !== userId) });
  }

  // ---- groups --------------------------------------------------------------------------------

  #peers(meta: Conversation): string[] {
    return meta.members.map((member) => member.userId).filter((userId) => userId !== this.#me);
  }

  /**
   * Makes sure this device can send in the conversation: identities pinned, group joined or
   * created, and group membership matching the directory. Concurrent calls share one run.
   */
  prepare(meta: Conversation, force = false): Promise<void> {
    const running = this.#preparing.get(meta.id);
    if (running !== undefined) return running;
    const run = this.#prepare(meta, force).finally(() => {
      this.#preparing.delete(meta.id);
    });
    this.#preparing.set(meta.id, run);
    return run;
  }

  async #prepare(meta: Conversation, force: boolean): Promise<void> {
    if (this.#status !== 'ready' || this.deviceId === null) throw new SecurityBlocked('device');
    const peers = this.#peers(meta);
    await this.#observe(meta.id, peers, force);
    let group = await this.#crypto.group(meta.id);
    if (!group.exists) {
      await this.processWelcomes();
      group = await this.#crypto.group(meta.id);
    }
    if (!group.exists) {
      await this.#createGroup(meta, peers);
      group = await this.#crypto.group(meta.id);
      if (!group.exists) return;
    }
    this.#update(meta.id, { waitingForWelcome: false });
    await this.#syncMembership(meta, peers, group.members);
    if (await this.#crypto.needsUpdate(meta.id)) {
      await this.#publish(meta.id, await this.#crypto.selfUpdate(meta.id));
    }
  }

  async #createGroup(meta: Conversation, peers: string[]): Promise<void> {
    const current = await this.#api.conversation(meta.id);
    if (current.epoch > 0) {
      // Someone else created the group; their Welcome will add this device.
      this.#update(meta.id, { waitingForWelcome: true });
      return;
    }
    const keyPackages: string[] = [];
    for (const peer of peers) {
      if ((await this.#userKeys(peer)) === null) continue;
      const claimed = await this.#api.claimKeyPackages(peer);
      keyPackages.push(...claimed.keyPackages.map((entry) => entry.keyPackage));
    }
    if (keyPackages.length === 0) {
      this.#update(meta.id, { peerNotReady: true });
      return;
    }
    const output = await this.#crypto.createGroup(meta.id, keyPackages, peers);
    const accepted = await this.#publish(meta.id, output);
    if (!accepted) {
      // Another member's device created the group first: use theirs. (A Welcome may already
      // have replaced our unconfirmed group; only discard it if it is still ours.)
      await this.#crypto.abandonUnconfirmed(meta.id);
      await this.processWelcomes();
      if (!(await this.#crypto.group(meta.id)).exists)
        this.#update(meta.id, { waitingForWelcome: true });
    }
  }

  /** Adds devices the directory lists but the group lacks, and removes revoked ones. */
  async #syncMembership(
    meta: Conversation,
    peers: string[],
    members: readonly { userId: string; deviceId: string }[],
  ): Promise<void> {
    const mine = await this.#userKeys(this.#me);
    const desired = new Map<string, Set<string>>();
    if (mine !== null)
      desired.set(this.#me, new Set(mine.devices.map((device) => device.deviceId)));
    const changed = this.security(meta.id).keyChanged;
    for (const peer of peers) {
      // Devices of a contact whose identity changed are not added until the user accepts it.
      if (changed.includes(peer)) continue;
      const keys = await this.#userKeys(peer);
      if (keys !== null) desired.set(peer, new Set(keys.devices.map((device) => device.deviceId)));
    }
    const present = new Set(members.map((member) => `${member.userId}/${member.deviceId}`));
    const remove: [string, string][] = members
      .filter((member) => {
        const devices = desired.get(member.userId);
        return devices !== undefined && !devices.has(member.deviceId);
      })
      .filter((member) => member.deviceId !== this.deviceId)
      .map((member) => [member.userId, member.deviceId]);
    const keyPackages: string[] = [];
    for (const [userId, devices] of desired) {
      const missing = [...devices].filter((deviceId) => !present.has(`${userId}/${deviceId}`));
      if (missing.length === 0) continue;
      const claimed = await this.#api.claimKeyPackages(userId);
      keyPackages.push(
        ...claimed.keyPackages
          .filter((entry) => missing.includes(entry.deviceId))
          .map((entry) => entry.keyPackage),
      );
    }
    if (keyPackages.length === 0 && remove.length === 0) return;
    const output = await this.#crypto.updateMembers(meta.id, keyPackages, remove, peers);
    await this.#publish(meta.id, output);
  }

  /**
   * Sends a commit to the delivery service. Accepted → merge; another commit won the epoch →
   * drop ours (the caller catches up and re-evaluates). Returns whether ours was accepted.
   */
  async #publish(conversationId: string, output: CommitOutput): Promise<boolean> {
    const deviceId = this.deviceId;
    if (deviceId === null) throw new SecurityBlocked('device');
    try {
      await this.#api.commit(conversationId, {
        clientMessageId: newId(),
        senderDeviceId: deviceId,
        epoch: output.epoch,
        commit: output.commit,
        welcome: output.welcome,
        welcomeTargets: output.welcomeTargets,
      });
    } catch (error) {
      if (!isConflict(error)) {
        await this.#crypto.clearPending(conversationId).catch(() => undefined);
        throw error;
      }
      await this.#crypto.clearPending(conversationId).catch(() => undefined);
      return false;
    }
    await this.#crypto.mergePending(conversationId);
    return true;
  }

  /** Joins every conversation a Welcome is waiting for. Returns the joined conversation ids. */
  processWelcomes(): Promise<string[]> {
    this.#welcomes ??= this.#processWelcomes().finally(() => {
      this.#welcomes = null;
    });
    return this.#welcomes;
  }

  async #processWelcomes(): Promise<string[]> {
    const deviceId = this.deviceId;
    if (deviceId === null || this.#status !== 'ready') return [];
    const { welcomes } = await this.#api.welcomes(deviceId);
    const joined: string[] = [];
    for (const welcome of welcomes) {
      try {
        const meta = await this.#api.conversation(welcome.conversationId);
        const peers = this.#peers(meta);
        await this.#observe(meta.id, peers);
        await this.#crypto.join(meta.id, welcome.welcome, peers, welcome.commitSeq);
        this.#update(meta.id, { waitingForWelcome: false, failed: false });
        joined.push(meta.id);
      } catch (error) {
        if (!(error instanceof WorkerCryptoError && error.code === 'GROUP_EXISTS')) {
          if (error instanceof WorkerCryptoError)
            this.#update(welcome.conversationId, { failed: true });
          else continue; // network problem: keep the Welcome and retry later
        }
      }
      await this.#api.ackWelcome(welcome.id).catch(() => undefined);
    }
    return joined;
  }

  // ---- messages ------------------------------------------------------------------------------

  async encrypt(
    meta: Conversation,
    content: string,
  ): Promise<{ ciphertext: string; epoch: number; senderDeviceId: string }> {
    await this.prepare(meta);
    const security = this.security(meta.id);
    if (security.keyChanged.length > 0) throw new SecurityBlocked('key-changed');
    const group = await this.#crypto.group(meta.id);
    if (!group.exists)
      throw new SecurityBlocked(security.peerNotReady ? 'peer-not-ready' : 'waiting');
    const deviceId = this.deviceId;
    if (deviceId === null) throw new SecurityBlocked('device');
    const encrypted = await this.#crypto.encrypt(meta.id, content);
    return { ...encrypted, senderDeviceId: deviceId };
  }

  async ingest(meta: Conversation, message: MailboxMessage): Promise<IngestResult> {
    const peers = this.#peers(meta);
    const inbound = {
      seq: message.seq,
      kind: message.kind,
      senderUserId: message.senderUserId,
      senderDeviceId: message.senderDeviceId,
      serverTime: message.serverTime,
      clientMessageId: message.clientMessageId,
      ciphertext: message.ciphertext,
    };
    let result = await this.#crypto.ingest(meta.id, inbound, peers);
    if (result.status === 'no-group') {
      await this.processWelcomes();
      result = await this.#crypto.ingest(meta.id, inbound, peers);
    }
    if (result.status === 'undecryptable' && message.kind === 'commit')
      this.#update(meta.id, { failed: true });
    if (result.status === 'commit' && result.removedSelf)
      this.#update(meta.id, { waitingForWelcome: true });
    return result;
  }

  recordOwn(conversationId: string, record: HistoryRecord): Promise<void> {
    return this.#crypto.recordOwn(conversationId, record);
  }

  history(conversationId: string): Promise<HistoryRecord[]> {
    return this.#crypto.history(conversationId);
  }

  cursor(conversationId: string): Promise<number> {
    return this.#crypto.cursor(conversationId);
  }
}
