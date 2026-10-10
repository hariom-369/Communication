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
 *
 * Single writer: a tab and the service worker can both open this store, but only the holder of
 * the device's Web Lock may change it (crypto/engine.ts). As a fence against a writer that lost
 * the lock mid-operation, each holder claims a new writer number, and every commit checks it
 * inside its transaction — a stale writer's commit aborts instead of overwriting newer state.
 */

const DB_VERSION = 2;
const STORES = ['meta', 'state', 'history', 'cursors', 'media'] as const;
/** Downloaded attachment ciphertext kept on this device (oldest evicted first). */
const MEDIA_CACHE_BYTES = 256 * 1024 * 1024;

interface CachedMedia {
  readonly blob: Blob;
  readonly size: number;
  readonly at: number;
}

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

/** Thrown by `commit` when another context has claimed the store since this one did. */
export class StaleWriterError extends Error {
  constructor() {
    super('Another tab or the service worker took over this device’s encryption state.');
    this.name = 'StaleWriterError';
  }
}

export class LocalStore {
  readonly #db: IDBDatabase;
  readonly #key: CryptoKey;
  #writer: number | null = null;

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
    // Another tab (or this one) is deleting or upgrading the database: let it, instead of
    // blocking it forever. This connection is unusable afterwards; the app reloads its state.
    db.onversionchange = () => {
      db.close();
    };
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

  /** Makes this connection the store's writer; earlier writers' commits fail from now on. */
  async claimWriter(): Promise<void> {
    const tx = this.#db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const current = ((await request(store.get('writer'))) as number | undefined) ?? 0;
    const next = current + 1;
    store.put(next, 'writer');
    await done(tx);
    this.#writer = next;
  }

  /** Conversation titles for the service worker's notifications (encrypted like the rest). */
  async labels(): Promise<Record<string, string>> {
    const tx = this.#db.transaction('meta', 'readonly');
    const sealed = (await request(tx.objectStore('meta').get('labels'))) as Sealed | undefined;
    if (sealed === undefined) return {};
    return JSON.parse(decoder.decode(await this.#open(sealed, 'meta|labels'))) as Record<
      string,
      string
    >;
  }

  async putLabels(labels: Record<string, string>): Promise<void> {
    const sealed = await this.#seal(encoder.encode(JSON.stringify(labels)), 'meta|labels');
    const tx = this.#db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(sealed, 'labels');
    await done(tx);
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

  /** Every conversation's history (for device-to-device transfer and backups). */
  async allHistory(): Promise<Map<string, unknown[]>> {
    const tx = this.#db.transaction('history', 'readonly');
    const store = tx.objectStore('history');
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    const out = new Map<string, unknown[]>();
    for (let i = 0; i < values.length; i += 1) {
      const [conversationId, seq] = keys[i] as [string, number];
      const bytes = await this.#open(values[i] as Sealed, `history|${conversationId}|${seq}`);
      const list = out.get(conversationId) ?? [];
      list.push(JSON.parse(decoder.decode(bytes)));
      out.set(conversationId, list);
    }
    return out;
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
    const tx = this.#db.transaction(['meta', 'state', 'history', 'cursors'], 'readwrite');
    const write = () => {
      if (state !== undefined) tx.objectStore('state').put(state, 'client');
      for (const entry of history) tx.objectStore('history').put(entry.value, entry.key);
      if (batch.clearCursors === true) tx.objectStore('cursors').clear();
      for (const entry of cursors) tx.objectStore('cursors').put(entry.value, entry.key);
    };
    const fence = { stale: false };
    if (this.#writer === null) write();
    else {
      const mine = this.#writer;
      const check = tx.objectStore('meta').get('writer');
      check.onsuccess = () => {
        if (check.result === mine) write();
        else {
          fence.stale = true;
          tx.abort();
        }
      };
    }
    try {
      await done(tx);
    } catch (error) {
      if (fence.stale) throw new StaleWriterError();
      throw error;
    }
  }

  /**
   * Attachment cache. Values are the attachment **ciphertext** exactly as downloaded: it is
   * already encrypted under the attachment key, which lives only inside the encrypted history,
   * so it is stored without a second layer (and can be large).
   */
  async getMedia(blobId: string): Promise<Blob | null> {
    const tx = this.#db.transaction('media', 'readonly');
    const entry = (await request(tx.objectStore('media').get(blobId))) as CachedMedia | undefined;
    return entry?.blob ?? null;
  }

  async putMedia(blobId: string, blob: Blob): Promise<void> {
    if (blob.size > MEDIA_CACHE_BYTES) return;
    const tx = this.#db.transaction('media', 'readwrite');
    const store = tx.objectStore('media');
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    const entries = (values as CachedMedia[])
      .map((value, index) => ({ key: keys[index] as string, size: value.size, at: value.at }))
      .sort((a, b) => a.at - b.at);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0) + blob.size;
    for (const entry of entries) {
      if (total <= MEDIA_CACHE_BYTES) break;
      store.delete(entry.key);
      total -= entry.size;
    }
    store.put({ blob, size: blob.size, at: Date.now() } satisfies CachedMedia, blobId);
    await done(tx);
  }

  /** Deletes everything for this user on this device. */
  static async destroy(userId: string, factory: IDBFactory = indexedDB): Promise<void> {
    await request(factory.deleteDatabase(LocalStore.databaseName(userId)));
  }
}
