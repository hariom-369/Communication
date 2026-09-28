// @vitest-environment node
import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import init, { CryptoClient } from '@tessera/crypto-core';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';

import { CryptoEngine, CryptoError } from './engine.js';
import { LocalStore } from './local-store.js';
import type { InboundMessage } from './protocol.js';

/**
 * Runs the worker engine against the real WebAssembly crypto core and an IndexedDB
 * implementation, as the browser worker does.
 */

const CONVERSATION = '0192f0c1-7a3b-7c4d-8e5f-000000000001';
const ALICE = '0192f0c1-0000-7000-8000-00000000000a';
const BOB = '0192f0c1-0000-7000-8000-00000000000b';

beforeAll(async () => {
  const wasm = readFileSync(
    new URL('../../../../packages/crypto-core/pkg/crypto_core_bg.wasm', import.meta.url),
  );
  await init({ module_or_path: wasm });
});

const core = { CryptoClient };

async function device(userId: string, factory = new IDBFactory()) {
  const engine = new CryptoEngine(core, factory);
  await engine.call('init', [userId]);
  const identity = await engine.call('createIdentity', [userId, 1]);
  return { engine, identity, factory };
}

let seq = 0;
function inbound(
  from: { identity: { userId: string; deviceId: string } },
  ciphertext: string,
  kind: InboundMessage['kind'] = 'application',
): InboundMessage {
  seq += 1;
  return {
    seq,
    kind,
    senderUserId: from.identity.userId,
    senderDeviceId: from.identity.deviceId,
    serverTime: new Date().toISOString(),
    clientMessageId: `m${seq}`,
    ciphertext,
  };
}

/** Alice and Bob in a conversation; Bob's view starts after Alice's creating commit. */
async function conversation() {
  seq = 0;
  const alice = await device(ALICE);
  const bob = await device(BOB);
  await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey, 1]);
  await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey, 1]);
  const [keyPackage] = await bob.engine.call('keyPackages', [1, false]);
  const created = await alice.engine.call('createGroup', [CONVERSATION, [keyPackage!], [BOB]]);
  await alice.engine.call('mergePending', [CONVERSATION]);
  const commit = inbound(alice, created.commit, 'commit');
  await bob.engine.call('join', [CONVERSATION, created.welcome!, [ALICE], commit.seq]);
  return { alice, bob, commit };
}

describe('crypto worker engine', () => {
  it('delivers messages and keeps decrypted history across restarts', async () => {
    const { alice, bob, commit } = await conversation();
    // The commit that added Bob is before his join point.
    expect(await bob.engine.call('ingest', [CONVERSATION, commit, [ALICE]])).toEqual({
      status: 'duplicate',
    });
    const content = JSON.stringify({ v: 1, text: 'hello bob' });
    const { ciphertext, epoch } = await alice.engine.call('encrypt', [CONVERSATION, content]);
    expect(epoch).toBe(1);
    const message = inbound(alice, ciphertext);
    const result = await bob.engine.call('ingest', [CONVERSATION, message, [ALICE]]);
    expect(result).toMatchObject({
      status: 'application',
      record: { seq: message.seq, senderUserId: ALICE, content },
    });

    // Restart Bob's worker on the same database.
    const restarted = new CryptoEngine(core, bob.factory);
    expect((await restarted.call('init', [BOB])).identity).toEqual(bob.identity);
    expect(await restarted.call('history', [CONVERSATION])).toEqual([
      expect.objectContaining({ seq: message.seq, content }),
    ]);
    expect(await restarted.call('cursor', [CONVERSATION])).toBe(message.seq);
    expect(await restarted.call('ingest', [CONVERSATION, message, [ALICE]])).toEqual({
      status: 'duplicate',
    });
  });

  it('never reuses a ratchet generation after a restart (state persisted before sending)', async () => {
    const { alice, bob } = await conversation();
    const first = await alice.engine.call('encrypt', [CONVERSATION, 'one']);
    // Alice's tab dies right after the ciphertext left the worker.
    const restarted = new CryptoEngine(core, alice.factory);
    await restarted.call('init', [ALICE]);
    const second = await restarted.call('encrypt', [CONVERSATION, 'two']);
    const a = await bob.engine.call('ingest', [
      CONVERSATION,
      inbound(alice, first.ciphertext),
      [ALICE],
    ]);
    const b = await bob.engine.call('ingest', [
      CONVERSATION,
      inbound(alice, second.ciphertext),
      [ALICE],
    ]);
    expect([a.status, b.status]).toEqual(['application', 'application']);
  });

  it('stores placeholders for undecryptable or mislabelled messages and moves on', async () => {
    const { alice, bob } = await conversation();
    const good = await alice.engine.call('encrypt', [CONVERSATION, 'real']);
    const bytes = Uint8Array.from(atob(good.ciphertext), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 0x01;
    const tampered = btoa(String.fromCharCode(...bytes));
    const bad = await bob.engine.call('ingest', [CONVERSATION, inbound(alice, tampered), [ALICE]]);
    expect(bad).toMatchObject({ status: 'undecryptable', record: { content: null } });

    // The server relabels a genuine message from Alice as coming from someone else.
    const next = await alice.engine.call('encrypt', [CONVERSATION, 'labelled']);
    const relabelled = { ...inbound(alice, next.ciphertext), senderUserId: BOB };
    expect(await bob.engine.call('ingest', [CONVERSATION, relabelled, [ALICE]])).toMatchObject({
      status: 'undecryptable',
      reason: 'SENDER_MISMATCH',
    });
    const after = await alice.engine.call('encrypt', [CONVERSATION, 'still fine']);
    expect(
      await bob.engine.call('ingest', [CONVERSATION, inbound(alice, after.ciphertext), [ALICE]]),
    ).toMatchObject({ status: 'application', record: { content: 'still fine' } });
  });

  it('recognises its own echoes and waits for a Welcome when it has no group', async () => {
    const { alice } = await conversation();
    const sent = await alice.engine.call('encrypt', [CONVERSATION, 'mine']);
    expect(
      await alice.engine.call('ingest', [CONVERSATION, inbound(alice, sent.ciphertext), [BOB]]),
    ).toEqual({
      status: 'own',
    });
    const stranger = await device('0192f0c1-0000-7000-8000-00000000000c');
    expect(
      await stranger.engine.call('ingest', [
        CONVERSATION,
        inbound(alice, sent.ciphertext),
        [ALICE],
      ]),
    ).toEqual({ status: 'no-group' });
  });

  it('keeps everything encrypted at rest under a key that cannot be exported', async () => {
    const { alice, bob } = await conversation();
    const secret = 'the eagle lands at midnight';
    const sent = await alice.engine.call('encrypt', [CONVERSATION, secret]);
    await bob.engine.call('ingest', [CONVERSATION, inbound(alice, sent.ciphertext), [ALICE]]);

    const open = bob.factory.open(LocalStore.databaseName(BOB));
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => {
        resolve(open.result);
      };
    });
    const dump = async (store: string) =>
      new Promise<unknown[]>((resolve) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => {
          resolve(req.result);
        };
      });
    const text = new TextDecoder('latin1');
    for (const store of ['state', 'history', 'cursors']) {
      for (const value of await dump(store)) {
        const sealed = value as { data: ArrayBuffer };
        expect(text.decode(new Uint8Array(sealed.data))).not.toContain(secret);
      }
    }
    const [key] = (await dump('meta')) as CryptoKey[];
    expect(key!.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow();
    db.close();
  });

  it('reports typed errors instead of failing silently', async () => {
    const engine = new CryptoEngine(core, new IDBFactory());
    await engine.call('init', [ALICE]);
    await expect(engine.call('encrypt', [CONVERSATION, 'x'])).rejects.toMatchObject({
      code: 'STATE',
    });
    const { engine: alice } = await device(ALICE);
    const error = await alice.call('encrypt', [CONVERSATION, 'x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe('NO_GROUP');
  });
});

describe('own commits', () => {
  it('treats the echo of an already merged commit as its own, not as a failure', async () => {
    const { alice, commit } = await conversation();
    expect(await alice.engine.call('ingest', [CONVERSATION, commit, [BOB]])).toEqual({
      status: 'own',
    });
    const { ciphertext } = await alice.engine.call('encrypt', [CONVERSATION, 'still usable']);
    expect(ciphertext.length).toBeGreaterThan(0);
  });
});

describe('simultaneous group creation', () => {
  it('lets a Welcome replace a group this device created but the server never confirmed', async () => {
    seq = 0;
    const alice = await device(ALICE);
    const bob = await device(BOB);
    await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey, 1]);
    await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey, 1]);
    const [bobPackage] = await bob.engine.call('keyPackages', [1, false]);
    const [alicePackage] = await alice.engine.call('keyPackages', [1, false]);
    // Both create the group at once; the server accepts Alice's commit.
    const fromAlice = await alice.engine.call('createGroup', [CONVERSATION, [bobPackage!], [BOB]]);
    await bob.engine.call('createGroup', [CONVERSATION, [alicePackage!], [ALICE]]);
    await alice.engine.call('mergePending', [CONVERSATION]);
    // Alice's Welcome reaches Bob before his own commit is rejected.
    const commit = inbound(alice, fromAlice.commit, 'commit');
    expect(
      await bob.engine.call('join', [CONVERSATION, fromAlice.welcome!, [ALICE], commit.seq]),
    ).toBe(1);
    const { ciphertext } = await alice.engine.call('encrypt', [CONVERSATION, 'we agree']);
    expect(
      await bob.engine.call('ingest', [CONVERSATION, inbound(alice, ciphertext), [ALICE]]),
    ).toMatchObject({ status: 'application', record: { content: 'we agree' } });
  });
});

describe('losing the creation race', () => {
  it('drops the unconfirmed group when the winning commit arrives, then joins by Welcome', async () => {
    seq = 0;
    const alice = await device(ALICE);
    const bob = await device(BOB);
    await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey, 1]);
    await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey, 1]);
    const [bobPackage] = await bob.engine.call('keyPackages', [1, false]);
    const [alicePackage] = await alice.engine.call('keyPackages', [1, false]);
    const fromAlice = await alice.engine.call('createGroup', [CONVERSATION, [bobPackage!], [BOB]]);
    await bob.engine.call('createGroup', [CONVERSATION, [alicePackage!], [ALICE]]);
    await alice.engine.call('mergePending', [CONVERSATION]);
    // The winning commit reaches Bob before the Welcome: not a failure, not consumed.
    const commit = inbound(alice, fromAlice.commit, 'commit');
    expect(await bob.engine.call('ingest', [CONVERSATION, commit, [ALICE]])).toEqual({
      status: 'no-group',
    });
    expect(await bob.engine.call('cursor', [CONVERSATION])).toBe(0);
    // Abandoning is a no-op now; joining works and the commit then counts as before-join.
    expect(await bob.engine.call('abandonUnconfirmed', [CONVERSATION])).toBe(false);
    await bob.engine.call('join', [CONVERSATION, fromAlice.welcome!, [ALICE], commit.seq]);
    expect(await bob.engine.call('abandonUnconfirmed', [CONVERSATION])).toBe(false);
    expect(await bob.engine.call('ingest', [CONVERSATION, commit, [ALICE]])).toEqual({
      status: 'duplicate',
    });
  });
});
