import type { CryptoClient, MediaDecryptor, MediaEncryptor } from '@tessera/crypto-core';

import { LocalStore } from './local-store.js';
import type {
  EncryptedBackup,
  GroupPolicy,
  HistoryBundle,
  CommitOutput,
  CryptoApi,
  DeviceRef,
  HistoryRecord,
  Identity,
  IdentityObservation,
  InboundMessage,
  IngestResult,
  MediaDigest,
  Method,
  Pin,
  SafetyNumber,
  SenderAuthority,
} from './protocol.js';

/**
 * The crypto worker's core (ADR-006), independent of the worker transport so it can be tested
 * against the real WebAssembly build.
 *
 * Invariants:
 * - calls run strictly one at a time (a queue), so MLS state never interleaves;
 * - every call that changes MLS state persists the new state **before** returning. In particular
 *   `encrypt` persists the advanced ratchet before the ciphertext leaves the worker, so a crash
 *   can never lead to a ratchet generation being reused;
 * - processing an inbound message and storing its plaintext happen in one transaction;
 * - if the WebAssembly instance traps, it is discarded and reloaded from the last persisted state.
 */

export interface CoreModule {
  readonly CryptoClient: {
    create(userId: string, askVersion: number, now: number): CryptoClient;
    createPending(userId: string, now: number): CryptoClient;
    restore(snapshot: Uint8Array): CryptoClient;
  };
  readonly MediaEncryptor: new () => MediaEncryptor;
  readonly MediaDecryptor: new (key: string, header: Uint8Array) => MediaDecryptor;
  parseLinkCode(code: string): string;
  verifyLinkCode(code: string, shortId: string, hpkePublic: string, signaturePublic: string): void;
}

export class CryptoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Errors from the Rust core arrive as `CODE: message`; anything else is a trap. */
function toCryptoError(error: unknown): CryptoError | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z_]+): (.*)$/s.exec(message);
  return match === null ? null : new CryptoError(match[1] ?? 'MLS', match[2] ?? '');
}

/** Methods that touch neither MLS state nor history: they need not wait behind MLS calls. */
const CONCURRENT: ReadonlySet<Method> = new Set<Method>([
  'mediaEncrypt',
  'mediaDecrypt',
  'mediaCached',
  'mediaCache',
]);
const MEDIA_CHUNK = 64 * 1024;
const MEDIA_TAG = 16;
const MEDIA_HEADER = 23;
/** Chunks read from the file per slice (1 MiB). */
const MEDIA_SLICE_CHUNKS = 16;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export class CryptoEngine {
  readonly #core: CoreModule;
  readonly #factory: IDBFactory | undefined;
  #store: LocalStore | null = null;
  #client: CryptoClient | null = null;
  #identity: Identity | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(core: CoreModule, factory?: IDBFactory) {
    this.#core = core;
    this.#factory = factory;
  }

  /** Runs `method` after every earlier call has finished. */
  call<M extends Method>(
    method: M,
    params: Parameters<CryptoApi[M]>,
  ): Promise<ReturnType<CryptoApi[M]>> {
    const run = async (): Promise<ReturnType<CryptoApi[M]>> => {
      const handler = this.#handlers[method] as (...args: unknown[]) => unknown;
      try {
        return (await handler(...params)) as ReturnType<CryptoApi[M]>;
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        const typed = toCryptoError(error);
        if (typed !== null) throw typed;
        await this.#recover();
        throw new CryptoError('CRASH', 'The encryption engine restarted; please retry.');
      }
    };
    if (CONCURRENT.has(method)) return run();
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #recover(): Promise<void> {
    this.#client = null;
    const state = await this.#store?.loadState();
    if (state !== null && state !== undefined)
      this.#client = this.#core.CryptoClient.restore(state);
  }

  get #c(): CryptoClient {
    if (this.#client === null)
      throw new CryptoError('STATE', 'No encryption identity on this device.');
    return this.#client;
  }

  get #s(): LocalStore {
    if (this.#store === null) throw new CryptoError('STATE', 'Not initialised.');
    return this.#store;
  }

  async #persist(extra: Omit<Parameters<LocalStore['commit']>[0], 'state'> = {}): Promise<void> {
    await this.#s.commit({ ...extra, state: new Uint8Array(this.#c.snapshot()) });
  }

  readonly #handlers: {
    [M in Method]: (...args: Parameters<CryptoApi[M]>) => Promise<ReturnType<CryptoApi[M]>>;
  } = {
    init: async (userId) => {
      this.#store?.close();
      this.#store = await LocalStore.open(userId, this.#factory);
      const state = await this.#store.loadState();
      this.#client = state === null ? null : this.#core.CryptoClient.restore(state);
      this.#identity =
        this.#client === null ? null : (JSON.parse(this.#client.identity()) as Identity);
      if (this.#identity !== null && this.#identity.userId !== userId) {
        throw new CryptoError('STATE', 'Stored identity belongs to another account.');
      }
      return { identity: this.#identity };
    },

    createIdentity: async (userId, askVersion) => {
      const client = this.#core.CryptoClient.create(userId, askVersion, now());
      // The new identity starts without groups: previous cursors no longer apply. Decrypted
      // history stays readable on this device.
      await this.#s.commit({ state: new Uint8Array(client.snapshot()), clearCursors: true });
      this.#client?.free();
      this.#client = client;
      this.#identity = JSON.parse(client.identity()) as Identity;
      return this.#identity;
    },

    keyPackages: async (count, lastResort) => {
      const packages = JSON.parse(this.#c.generateKeyPackages(count, lastResort)) as string[];
      await this.#persist();
      return packages;
    },

    observeIdentity: async (userId, publicKey, version) => {
      const observation = JSON.parse(
        this.#c.observeIdentity(userId, publicKey, version),
      ) as IdentityObservation;
      if (observation !== 'unchanged') await this.#persist();
      return observation;
    },

    pin: (userId) => Promise.resolve(JSON.parse(this.#c.pin(userId)) as Pin | null),

    setVerified: async (userId, verified) => {
      this.#c.setVerified(userId, verified);
      await this.#persist();
    },

    acknowledgeChange: async (userId) => {
      this.#c.acknowledgeChange(userId);
      await this.#persist();
    },

    safetyNumber: (userId) =>
      Promise.resolve(JSON.parse(this.#c.safetyNumber(userId)) as SafetyNumber),

    qrMatches: (userId, scanned) => Promise.resolve(this.#c.qrMatches(userId, scanned)),

    group: (conversationId) => {
      const exists = this.#c.hasGroup(conversationId);
      return Promise.resolve({
        exists,
        epoch: exists ? this.#c.epoch(conversationId) : 0,
        members: exists ? (JSON.parse(this.#c.members(conversationId)) as DeviceRef[]) : [],
      });
    },

    createGroup: async (conversationId, keyPackages, allowed, policy) => {
      const output = JSON.parse(
        this.#c.createGroup(
          conversationId,
          JSON.stringify(keyPackages),
          JSON.stringify(allowed),
          policy === null ? undefined : JSON.stringify(policy),
          now(),
        ),
      ) as CommitOutput;
      await this.#persist();
      return output;
    },

    groupPolicy: (conversationId) => Promise.resolve(this.#policy(conversationId)),

    updatePolicy: async (conversationId, policy, allowed) => {
      const output = JSON.parse(
        this.#c.updatePolicy(conversationId, JSON.stringify(policy), JSON.stringify(allowed)),
      ) as CommitOutput;
      await this.#persist();
      return output;
    },

    mergePending: async (conversationId) => {
      const epoch = this.#c.mergePending(conversationId, now());
      await this.#persist();
      return epoch;
    },

    clearPending: async (conversationId) => {
      this.#c.clearPending(conversationId);
      await this.#persist();
    },

    discardGroup: async (conversationId) => {
      this.#c.discardGroup(conversationId);
      await this.#persist();
    },

    abandonUnconfirmed: async (conversationId) => {
      if (!this.#c.hasGroup(conversationId) || this.#c.epoch(conversationId) !== 0) return false;
      this.#c.discardGroup(conversationId);
      await this.#persist();
      return true;
    },

    join: async (conversationId, welcome, allowed, commitSeq) => {
      // A group we created but the server never confirmed (epoch 0) lost the race: a Welcome
      // exists only because another member's creating commit was accepted instead.
      if (this.#c.hasGroup(conversationId) && this.#c.epoch(conversationId) === 0) {
        this.#c.discardGroup(conversationId);
      }
      const epoch = this.#c.join(conversationId, welcome, JSON.stringify(allowed), now());
      // Everything up to and including the commit that added us predates this device.
      await this.#persist({ cursors: [{ conversationId, seq: commitSeq }] });
      return epoch;
    },

    encrypt: async (conversationId, content) => {
      const ciphertext = this.#c.encrypt(conversationId, encoder.encode(content));
      const epoch = this.#c.epoch(conversationId);
      await this.#persist(); // before the ciphertext leaves: no generation reuse after a crash
      return { ciphertext, epoch };
    },

    ingest: async (conversationId, message, allowed) =>
      this.#ingest(conversationId, message, allowed),

    recordOwn: async (conversationId, record) => {
      const authority = this.#authority(conversationId, record.senderUserId);
      const stored = authority === undefined ? record : { ...record, authority };
      await this.#s.commit({ history: [{ conversationId, seq: record.seq, record: stored }] });
      return stored;
    },

    history: async (conversationId) => (await this.#s.history(conversationId)) as HistoryRecord[],

    cursor: (conversationId) => this.#s.cursor(conversationId),

    updateMembers: async (conversationId, keyPackages, remove, allowed) => {
      const output = JSON.parse(
        this.#c.updateMembers(
          conversationId,
          JSON.stringify(keyPackages),
          JSON.stringify(remove),
          JSON.stringify(allowed),
        ),
      ) as CommitOutput;
      await this.#persist();
      return output;
    },

    needsUpdate: (conversationId) => Promise.resolve(this.#c.needsUpdate(conversationId, now())),

    selfUpdate: async (conversationId) => {
      const output = JSON.parse(this.#c.selfUpdate(conversationId)) as CommitOutput;
      await this.#persist();
      return output;
    },

    reset: async (userId) => {
      this.#store?.close();
      this.#store = null;
      this.#client?.free();
      this.#client = null;
      this.#identity = null;
      await LocalStore.destroy(userId, this.#factory);
      this.#store = await LocalStore.open(userId, this.#factory);
    },

    createPending: async (userId) => {
      const client = this.#core.CryptoClient.createPending(userId, now());
      await this.#s.commit({ state: new Uint8Array(client.snapshot()), clearCursors: true });
      this.#client?.free();
      this.#client = client;
      this.#identity = JSON.parse(client.identity()) as Identity;
      return this.#identity;
    },

    linkRequest: () =>
      Promise.resolve(
        JSON.parse(this.#c.linkRequest()) as { hpkePublic: string; signaturePublic: string },
      ),

    linkCode: (shortId) => Promise.resolve(this.#c.linkCode(shortId)),

    parseLinkCode: (code) => Promise.resolve(this.#core.parseLinkCode(code)),

    verifyLinkCode: (code, shortId, hpkePublic, signaturePublic) => {
      this.#core.verifyLinkCode(code, shortId, hpkePublic, signaturePublic);
      return Promise.resolve();
    },

    approveLink: async (
      code,
      shortId,
      deviceId,
      hpkePublic,
      signaturePublic,
      trusted,
      includeHistory,
    ) => {
      const history = includeHistory ? await this.#bundle() : new Uint8Array();
      return this.#c.approveLink(
        code,
        shortId,
        deviceId,
        hpkePublic,
        signaturePublic,
        trusted,
        history,
        now(),
      );
    },

    completeLink: async (sealed, shortId, expectedAsk, version) => {
      const history = this.#c.completeLink(sealed, shortId, expectedAsk, version);
      this.#identity = JSON.parse(this.#c.identity()) as Identity;
      await this.#persistWithBundle(history);
      return this.#identity;
    },

    observeDevices: async (userId, deviceIds) => {
      const added = JSON.parse(
        this.#c.observeDevices(userId, JSON.stringify(deviceIds)),
      ) as string[];
      await this.#persist();
      return added;
    },

    backupEnable: async () => {
      const result = JSON.parse(this.#c.backupEnable()) as { recoveryKey: string; wrap: string };
      await this.#persist();
      this.#identity = JSON.parse(this.#c.identity()) as Identity;
      return result;
    },

    backupNewRecoveryKey: () =>
      Promise.resolve(
        JSON.parse(this.#c.backupNewRecoveryKey()) as { recoveryKey: string; wrap: string },
      ),

    backupPasskeyWrap: (prfOutput) =>
      Promise.resolve(this.#c.backupPasskeyWrap(fromBase64(prfOutput))),

    mediaEncrypt: (file) => this.#encryptMedia(file),
    mediaDecrypt: (ciphertext, digest, type) => this.#decryptMedia(ciphertext, digest, type),
    mediaCached: (blobId) => this.#s.getMedia(blobId),
    mediaCache: (blobId, ciphertext) => this.#s.putMedia(blobId, ciphertext),

    backupOwns: (manifest, mac) => Promise.resolve(this.#c.backupOwns(manifest, mac)),

    backupExport: async (version) => {
      const app = await this.#bundle();
      return JSON.parse(this.#c.backupExport(app, version, undefined, now())) as EncryptedBackup;
    },

    backupRestore: async (kind, secret, wrap, backup, expectedAsk, version) => {
      const result = JSON.parse(
        this.#c.backupRestore(
          kind,
          secret,
          wrap,
          backup.blob,
          backup.manifest,
          backup.mac,
          expectedAsk,
          version,
          now(),
        ),
      ) as { app: string; version: number; createdAt: number };
      this.#identity = JSON.parse(this.#c.identity()) as Identity;
      await this.#persistWithBundle(fromBase64(result.app));
      return { identity: this.#identity, version: result.version, createdAt: result.createdAt };
    },
  };

  /** Streams a file through the media encryptor in 1 MiB slices (crypto-core media.rs). */
  async #encryptMedia(file: Blob): Promise<{ ciphertext: Blob; digest: MediaDigest }> {
    const encryptor = new this.#core.MediaEncryptor();
    try {
      const parts: Uint8Array<ArrayBuffer>[] = [encryptor.header() as Uint8Array<ArrayBuffer>];
      const fullChunks = Math.floor(file.size / MEDIA_CHUNK);
      for (let chunk = 0; chunk < fullChunks; chunk += MEDIA_SLICE_CHUNKS) {
        const count = Math.min(MEDIA_SLICE_CHUNKS, fullChunks - chunk);
        const slice = new Uint8Array(
          await file.slice(chunk * MEDIA_CHUNK, (chunk + count) * MEDIA_CHUNK).arrayBuffer(),
        );
        for (let i = 0; i < count; i += 1)
          parts.push(
            encryptor.push(
              slice.subarray(i * MEDIA_CHUNK, (i + 1) * MEDIA_CHUNK),
            ) as Uint8Array<ArrayBuffer>,
          );
      }
      const last = new Uint8Array(await file.slice(fullChunks * MEDIA_CHUNK).arrayBuffer());
      parts.push(encryptor.finish(last) as Uint8Array<ArrayBuffer>);
      const digest = JSON.parse(encryptor.digest()) as MediaDigest;
      return { ciphertext: new Blob(parts, { type: 'application/octet-stream' }), digest };
    } finally {
      encryptor.free();
    }
  }

  /** Decrypts in slices; the plaintext is returned only after the digest checks out. */
  async #decryptMedia(ciphertext: Blob, digest: MediaDigest, type: string): Promise<Blob> {
    if (ciphertext.size !== digest.ciphertextSize || ciphertext.size < MEDIA_HEADER + MEDIA_TAG)
      throw new CryptoError('UNTRUSTED', 'media does not match the message');
    const header = new Uint8Array(await ciphertext.slice(0, MEDIA_HEADER).arrayBuffer());
    const decryptor = new this.#core.MediaDecryptor(digest.key, header);
    try {
      const full = MEDIA_CHUNK + MEDIA_TAG;
      const body = ciphertext.size - MEDIA_HEADER;
      const lastLength = body % full === 0 ? full : body % full;
      const fullChunks = (body - lastLength) / full;
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let chunk = 0; chunk < fullChunks; chunk += MEDIA_SLICE_CHUNKS) {
        const count = Math.min(MEDIA_SLICE_CHUNKS, fullChunks - chunk);
        const start = MEDIA_HEADER + chunk * full;
        const slice = new Uint8Array(
          await ciphertext.slice(start, start + count * full).arrayBuffer(),
        );
        for (let i = 0; i < count; i += 1)
          parts.push(
            decryptor.push(slice.subarray(i * full, (i + 1) * full)) as Uint8Array<ArrayBuffer>,
          );
      }
      const last = new Uint8Array(
        await ciphertext.slice(ciphertext.size - lastLength).arrayBuffer(),
      );
      parts.push(decryptor.finish(last, JSON.stringify(digest)) as Uint8Array<ArrayBuffer>);
      return new Blob(parts, { type });
    } finally {
      decryptor.free();
    }
  }

  #policy(conversationId: string): GroupPolicy | null {
    if (!this.#c.hasGroup(conversationId)) return null;
    return JSON.parse(this.#c.groupPolicy(conversationId)) as GroupPolicy | null;
  }

  /** What a user may do under the policy in force now (the epoch the message was sent in). */
  #authority(conversationId: string, userId: string): SenderAuthority | undefined {
    const policy = this.#policy(conversationId);
    if (policy === null) return undefined;
    const role =
      policy.owner === userId ? 'owner' : policy.admins.includes(userId) ? 'admin' : 'member';
    return {
      role,
      editInfo: role !== 'member' || policy.membersCanEditInfo,
      add: role !== 'member' || policy.membersCanAdd,
    };
  }

  /** All local history as a bundle (JSON bytes). */
  async #bundle(): Promise<Uint8Array> {
    const conversations: Record<string, HistoryRecord[]> = {};
    for (const [id, records] of await this.#s.allHistory())
      conversations[id] = records as HistoryRecord[];
    const bundle: HistoryBundle = { v: 1, conversations };
    return encoder.encode(JSON.stringify(bundle));
  }

  /** Persists the new identity state together with imported history, in one transaction. */
  async #persistWithBundle(bytes: Uint8Array): Promise<void> {
    const history: { conversationId: string; seq: number; record: HistoryRecord }[] = [];
    if (bytes.length > 0) {
      let bundle: HistoryBundle | null;
      try {
        bundle = JSON.parse(decoder.decode(bytes)) as HistoryBundle;
      } catch {
        bundle = null; // unreadable history is skipped; the identity still counts
      }
      if (bundle?.v === 1 && typeof bundle.conversations === 'object') {
        for (const [conversationId, records] of Object.entries(bundle.conversations)) {
          if (!Array.isArray(records)) continue;
          for (const record of records) {
            if (typeof record.seq === 'number' && Number.isSafeInteger(record.seq))
              history.push({ conversationId, seq: record.seq, record });
          }
        }
      }
    }
    await this.#persist({ history, clearCursors: true });
  }

  async #ingest(
    conversationId: string,
    message: InboundMessage,
    allowed: string[],
  ): Promise<IngestResult> {
    const cursor = { conversationId, seq: message.seq };
    if (message.seq <= (await this.#s.cursor(conversationId))) return { status: 'duplicate' };
    if (!this.#c.hasGroup(conversationId)) return { status: 'no-group' };
    const own = message.senderDeviceId === this.#identity?.deviceId;
    if (!own && message.kind === 'commit' && this.#c.epoch(conversationId) === 0) {
      // Another member's creating commit: our own unconfirmed group lost the race. Drop it and
      // wait for their Welcome, without consuming this message.
      this.#c.discardGroup(conversationId);
      await this.#persist();
      return { status: 'no-group' };
    }
    if (own && message.kind === 'application') {
      await this.#s.commit({ cursors: [cursor] });
      return { status: 'own' };
    }
    const placeholder = (): HistoryRecord => ({
      seq: message.seq,
      senderUserId: message.senderUserId,
      senderDeviceId: message.senderDeviceId,
      serverTime: message.serverTime,
      clientMessageId: message.clientMessageId,
      content: null,
    });
    let processed:
      | { kind: 'application'; plaintext: string; senderUserId: string; senderDeviceId: string }
      | { kind: 'commit'; epoch: number; removedSelf: boolean };
    try {
      processed = JSON.parse(
        this.#c.process(conversationId, message.ciphertext, JSON.stringify(allowed)),
      ) as typeof processed;
    } catch (error) {
      const typed = toCryptoError(error);
      if (typed === null) throw error; // trap: recover, do not advance
      // Our own commit echoed back was already merged when the server accepted it (or dropped
      // when it was rejected): nothing to do.
      if (own && message.kind === 'commit') {
        await this.#persist({ cursors: [cursor] });
        return { status: 'own' };
      }
      if (typed.code === 'DUPLICATE' || typed.code === 'OWN_MESSAGE') {
        await this.#persist({ cursors: [cursor] });
        return { status: typed.code === 'DUPLICATE' ? 'duplicate' : 'own' };
      }
      const record = placeholder();
      await this.#persist({
        history:
          message.kind === 'application' ? [{ conversationId, seq: message.seq, record }] : [],
        cursors: [cursor],
      });
      return { status: 'undecryptable', reason: typed.code, record };
    }
    if (processed.kind === 'commit') {
      await this.#persist({ cursors: [cursor] });
      return { status: 'commit', epoch: processed.epoch, removedSelf: processed.removedSelf };
    }
    // The authenticated MLS sender is authoritative; a server label that disagrees is an attack.
    if (processed.senderUserId !== message.senderUserId) {
      const record = placeholder();
      await this.#persist({
        history: [{ conversationId, seq: message.seq, record }],
        cursors: [cursor],
      });
      return { status: 'undecryptable', reason: 'SENDER_MISMATCH', record };
    }
    let record: HistoryRecord = {
      seq: message.seq,
      senderUserId: processed.senderUserId,
      senderDeviceId: processed.senderDeviceId,
      serverTime: message.serverTime,
      clientMessageId: message.clientMessageId,
      content: decoder.decode(fromBase64(processed.plaintext)),
    };
    const authority = this.#authority(conversationId, processed.senderUserId);
    if (authority !== undefined) record = { ...record, authority };
    await this.#persist({
      history: [{ conversationId, seq: message.seq, record }],
      cursors: [cursor],
    });
    return { status: 'application', record };
  }
}
