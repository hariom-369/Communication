import type { CryptoClient } from '@tessera/crypto-core';

import { LocalStore } from './local-store.js';
import type {
  CommitOutput,
  CryptoApi,
  DeviceRef,
  HistoryRecord,
  Identity,
  IdentityObservation,
  InboundMessage,
  IngestResult,
  Method,
  Pin,
  SafetyNumber,
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
    restore(snapshot: Uint8Array): CryptoClient;
  };
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

    createGroup: async (conversationId, keyPackages, allowed) => {
      const output = JSON.parse(
        this.#c.createGroup(
          conversationId,
          JSON.stringify(keyPackages),
          JSON.stringify(allowed),
          now(),
        ),
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
      await this.#s.commit({ history: [{ conversationId, seq: record.seq, record }] });
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
  };

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
    const record: HistoryRecord = {
      seq: message.seq,
      senderUserId: processed.senderUserId,
      senderDeviceId: processed.senderDeviceId,
      serverTime: message.serverTime,
      clientMessageId: message.clientMessageId,
      content: decoder.decode(fromBase64(processed.plaintext)),
    };
    await this.#persist({
      history: [{ conversationId, seq: message.seq, record }],
      cursors: [cursor],
    });
    return { status: 'application', record };
  }
}
