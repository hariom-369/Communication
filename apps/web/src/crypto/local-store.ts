/**
 * Encrypted on-device store for end-to-end encryption state and decrypted history
 * (docs/crypto-design.md §10, ADR-006). Runs only inside the crypto worker.
 *
 * Every value is AES-256-GCM encrypted under a per-device Local Storage Key (LSK): a
 * **non-extractable** WebCrypto key that is itself kept in IndexedDB (structured clone), so
 * script can use it but never read its bytes. A random 96-bit IV per record, and additional
 * authenticated data binding each ciphertext to its store and key, so records cannot be swapped.
 *
 * Honest limits (ADR-006): this protects copies of the browser profile, not a compromised
 * device or a script running in our origin.
 *
 * `commit()` writes the MLS state, history records and cursors in **one** IndexedDB transaction,
 * so the ratchet state and the messages it produced are persisted together or not at all.
 */

const DB_VERSION = 1;
const STORES = ['meta', 'state', 'history', 'cursors'] as const;

interface Sealed {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
}

export interface HistoryWrite {
  readonly conversationId: string;
  readonly seq: number;
  readonly record: unknown;
}

export interface CommitBatch {
  readonly state?: Uint8Array<ArrayBuffer>;
  readonly history?: readonly HistoryWrite[];
  readonly cursors?: readonly { conversationId: string; seq: number }[];
  /** Deletes every cursor (identity reset: the new device joins conversations afresh). */
  readonly clearCursors?: boolean;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class LocalStore {
  readonly #db: IDBDatabase;
  readonly #key: CryptoKey;

  private constructor(db: IDBDatabase, key: CryptoKey) {
    this.#db = db;
    this.#key = key;
  }

  static databaseName(userId: string): string {
    return `tessera-e2ee-v1:${userId}`;
  }

  /** Opens (or creates) the store for one user on this device. */
  static async open(userId: string, factory: IDBFactory = indexedDB): Promise<LocalStore> {
    const openRequest = factory.open(LocalStore.databaseName(userId), DB_VERSION);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      for (const name of STORES)
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    const db = await request(openRequest);
    const tx = db.transaction('meta', 'readonly');
    let key = (await request(tx.objectStore('meta').get('lsk'))) as CryptoKey | undefined;
    if (key === undefined) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      const write = db.transaction('meta', 'readwrite');
      // `add` fails if another tab created a key first; then use theirs.
      write.objectStore('meta').add(key, 'lsk');
      try {
        await done(write);
      } catch {
        const retry = db.transaction('meta', 'readonly');
        key = (await request(retry.objectStore('meta').get('lsk'))) as CryptoKey;
      }
    }
    return new LocalStore(db, key);
  }

  close(): void {
    this.#db.close();
  }

  async #seal(plaintext: Uint8Array<ArrayBuffer>, aad: string): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      this.#key,
      plaintext,
    );
    return { iv, data };
  }

  async #open(sealed: Sealed, aad: string): Promise<Uint8Array<ArrayBuffer>> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData: encoder.encode(aad) },
      this.#key,
      sealed.data,
    );
    return new Uint8Array(plaintext);
  }

  async loadState(): Promise<Uint8Array<ArrayBuffer> | null> {
    const tx = this.#db.transaction('state', 'readonly');
    const sealed = (await request(tx.objectStore('state').get('client'))) as Sealed | undefined;
    return sealed === undefined ? null : this.#open(sealed, 'state|client');
  }

  async cursor(conversationId: string): Promise<number> {
    const tx = this.#db.transaction('cursors', 'readonly');
    const sealed = (await request(tx.objectStore('cursors').get(conversationId))) as
      Sealed | undefined;
    if (sealed === undefined) return 0;
    return Number(decoder.decode(await this.#open(sealed, `cursor|${conversationId}`)));
  }

  async history(conversationId: string): Promise<unknown[]> {
    const tx = this.#db.transaction('history', 'readonly');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]);
    const store = tx.objectStore('history');
    const [keys, values] = await Promise.all([
      request(store.getAllKeys(range)),
      request(store.getAll(range)),
    ]);
    const records: unknown[] = [];
    for (let i = 0; i < values.length; i += 1) {
      const [, seq] = keys[i] as [string, number];
      const bytes = await this.#open(values[i] as Sealed, `history|${conversationId}|${seq}`);
      records.push(JSON.parse(decoder.decode(bytes)));
    }
    return records;
  }

  /** Atomically persists state, history records and cursors (all encrypted first). */
  async commit(batch: CommitBatch): Promise<void> {
    const state =
      batch.state === undefined ? undefined : await this.#seal(batch.state, 'state|client');
    const history = await Promise.all(
      (batch.history ?? []).map(async (write) => ({
        key: [write.conversationId, write.seq],
        value: await this.#seal(
          encoder.encode(JSON.stringify(write.record)),
          `history|${write.conversationId}|${write.seq}`,
        ),
      })),
    );
    const cursors = await Promise.all(
      (batch.cursors ?? []).map(async (cursor) => ({
        key: cursor.conversationId,
        value: await this.#seal(
          encoder.encode(String(cursor.seq)),
          `cursor|${cursor.conversationId}`,
        ),
      })),
    );
    // Encryption is done: everything below is synchronous IndexedDB work in one transaction.
    const tx = this.#db.transaction(['state', 'history', 'cursors'], 'readwrite');
    if (state !== undefined) tx.objectStore('state').put(state, 'client');
    for (const entry of history) tx.objectStore('history').put(entry.value, entry.key);
    if (batch.clearCursors === true) tx.objectStore('cursors').clear();
    for (const entry of cursors) tx.objectStore('cursors').put(entry.value, entry.key);
    await done(tx);
  }

  /** Deletes everything for this user on this device. */
  static async destroy(userId: string, factory: IDBFactory = indexedDB): Promise<void> {
    await request(factory.deleteDatabase(LocalStore.databaseName(userId)));
  }
}
