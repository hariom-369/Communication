/**
 * Per-device notification settings (docs/notifications.md §2): what a notification may show, and
 * which encryption device this browser is. Kept in this browser only — the server never learns
 * how much a notification reveals. Shared with the service worker (same origin, IndexedDB).
 */

export const PREVIEW_LEVELS = ['full', 'name', 'none'] as const;
/** `full`: sender and message; `name`: conversation only; `none`: just "New message". */
export type PreviewLevel = (typeof PREVIEW_LEVELS)[number];

export interface DevicePrefs {
  readonly preview: PreviewLevel;
  /** This browser's encryption device (for re-subscribing when the push service rotates). */
  readonly deviceId: string | null;
  /** The person turned push on for this browser (and has not turned it off). */
  readonly push: boolean;
}

/** Privacy by default (docs/privacy.md §2): notifications say only that something is new. */
export const DEFAULT_DEVICE_PREFS: DevicePrefs = { preview: 'none', deviceId: null, push: false };

function isPreviewLevel(value: unknown): value is PreviewLevel {
  return PREVIEW_LEVELS.some((level) => level === value);
}

const DB_NAME = 'tessera-device-prefs-v1';
const STORE = 'prefs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB unavailable'));
    };
  });
}

export async function readDevicePrefs(userId: string): Promise<DevicePrefs> {
  try {
    const db = await openDb();
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(userId);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('read failed'));
        };
      });
      const stored = (value ?? {}) as Partial<Record<keyof DevicePrefs, unknown>>;
      return {
        preview: isPreviewLevel(stored.preview) ? stored.preview : DEFAULT_DEVICE_PREFS.preview,
        deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : null,
        push: stored.push === true,
      };
    } finally {
      db.close();
    }
  } catch {
    return DEFAULT_DEVICE_PREFS;
  }
}

export async function writeDevicePrefs(
  userId: string,
  change: Partial<DevicePrefs>,
): Promise<void> {
  const next = { ...(await readDevicePrefs(userId)), ...change };
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(next, userId);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('write failed'));
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Messages the service worker decrypted and notified about while no tab was open. The server
 * then counts them as delivered, but they are still unread: the app starts counting from here.
 * Per conversation, the first such message's sequence number.
 */
async function updateUnseen(
  userId: string,
  change: (current: Record<string, number>) => Record<string, number>,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(`${userId}:unseen`);
      request.onsuccess = () => {
        const current = (request.result ?? {}) as Record<string, number>;
        store.put(change(current), `${userId}:unseen`);
      };
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('write failed'));
      };
    });
  } finally {
    db.close();
  }
}

export function addUnseen(userId: string, conversationId: string, seq: number): Promise<void> {
  return updateUnseen(userId, (current) => ({
    ...current,
    [conversationId]: Math.min(current[conversationId] ?? seq, seq),
  }));
}

export async function readUnseen(userId: string): Promise<Record<string, number>> {
  try {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction(STORE, 'readonly')
          .objectStore(STORE)
          .get(`${userId}:unseen`);
        request.onsuccess = () => {
          resolve((request.result ?? {}) as Record<string, number>);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('read failed'));
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

export function clearUnseen(userId: string, conversationId: string): Promise<void> {
  return updateUnseen(userId, (current) => {
    const { [conversationId]: _seen, ...rest } = current;
    return rest;
  });
}
