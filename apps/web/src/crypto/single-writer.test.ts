// @vitest-environment node
import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import init, {
  CryptoClient,
  MediaDecryptor,
  MediaEncryptor,
  parseLinkCode,
  verifyLinkCode,
} from '@tessera/crypto-core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CryptoEngine } from './engine.js';
import { LocalStore, StaleWriterError } from './local-store.js';

/**
 * One writer per device (ADR-048): a tab and the service worker share this device's encryption
 * state, so only the holder of the device's Web Lock may change it, and a writer that lost it
 * cannot overwrite newer state (the writer fence in the local store).
 */

const ALICE = '0192f0c1-0000-7000-8000-00000000000a';
const core = { CryptoClient, MediaEncryptor, MediaDecryptor, parseLinkCode, verifyLinkCode };

beforeAll(async () => {
  const wasm = readFileSync(
    new URL('../../../../packages/crypto-core/pkg/crypto_core_bg.wasm', import.meta.url),
  );
  await init({ module_or_path: wasm });
});

/** A small in-memory Web Locks implementation with the semantics the engine relies on. */
class FakeLocks {
  #held = new Map<string, { release: () => void; reject: (error: Error) => void }>();
  #waiting = new Map<string, (() => void)[]>();

  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void> | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        const held = callback({ name, mode: 'exclusive' });
        this.#held.set(name, { release: () => undefined, reject });
        void Promise.resolve(held).then(() => {
          if (this.#held.get(name)?.reject === reject) this.#release(name);
          resolve();
        });
      };
      const current = this.#held.get(name);
      if (current === undefined) {
        grant();
        return;
      }
      if (options.ifAvailable === true) {
        void Promise.resolve(callback(null)).then(() => resolve());
        return;
      }
      if (options.steal === true) {
        const error = new Error('stolen');
        error.name = 'AbortError';
        this.#held.delete(name);
        current.reject(error);
        grant();
        return;
      }
      const queue = this.#waiting.get(name) ?? [];
      queue.push(grant);
      this.#waiting.set(name, queue);
      options.signal?.addEventListener('abort', () => {
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        reject(new Error('timeout'));
      });
    });
  }

  #release(name: string): void {
    this.#held.delete(name);
    this.#waiting.get(name)?.shift()?.();
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function withLocks(locks: FakeLocks): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { locks },
    configurable: true,
  });
}
afterEach(() => {
  if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original);
});

describe('single writer per device', () => {
  it('fences a writer once another context claimed the store', async () => {
    const factory = new IDBFactory();
    const first = await LocalStore.open(ALICE, factory);
    await first.claimWriter();
    await first.commit({ cursors: [{ conversationId: 'c', seq: 1 }] });
    const second = await LocalStore.open(ALICE, factory);
    await second.claimWriter();
    await expect(
      first.commit({ cursors: [{ conversationId: 'c', seq: 5 }] }),
    ).rejects.toBeInstanceOf(StaleWriterError);
    await second.commit({ cursors: [{ conversationId: 'c', seq: 2 }] });
    expect(await second.cursor('c')).toBe(2);
  });

  it('stops an engine whose state another engine took over (LOCKED, nothing written)', async () => {
    const factory = new IDBFactory();
    const tab = new CryptoEngine(core, factory);
    await tab.call('init', [ALICE]);
    await tab.call('createIdentity', [ALICE, 1]);
    const other = new CryptoEngine(core, factory);
    await other.call('init', [ALICE]);
    await expect(tab.call('keyPackages', [1, false])).rejects.toMatchObject({ code: 'LOCKED' });
    await expect(tab.call('labels', [])).rejects.toMatchObject({ code: 'LOCKED' });
    expect(await other.call('keyPackages', [1, false])).toHaveLength(1);
  });

  it('lets one context hold the device lock: wait, try, steal', async () => {
    const locks = new FakeLocks();
    withLocks(locks);
    const factory = new IDBFactory();
    const tab = new CryptoEngine(core, factory);
    let lost = 0;
    tab.onLockLost = () => {
      lost += 1;
    };
    expect(await tab.call('acquire', [ALICE, 'wait'])).toBe('acquired');

    // The service worker does not wait: a tab is open.
    const worker = new CryptoEngine(core, factory);
    expect(await worker.call('acquire', [ALICE, 'try'])).toBe('busy');

    // A second tab takes over ("Use here"): the first is told and stops.
    const second = new CryptoEngine(core, factory);
    expect(await second.call('acquire', [ALICE, 'steal'])).toBe('acquired');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lost).toBe(1);
    await expect(tab.call('labels', [])).rejects.toMatchObject({ code: 'LOCKED' });

    // When the holder lets go, the service worker can take it.
    second.releaseLock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await worker.call('acquire', [ALICE, 'try'])).toBe('acquired');
  });
});
