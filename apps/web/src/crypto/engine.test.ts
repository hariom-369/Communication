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

const core = { CryptoClient, MediaEncryptor, MediaDecryptor, parseLinkCode, verifyLinkCode };

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
  await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey!, 1]);
  await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey!, 1]);
  const [keyPackage] = await bob.engine.call('keyPackages', [1, false]);
  const created = await alice.engine.call('createGroup', [
    CONVERSATION,
    [keyPackage!],
    [BOB],
    null,
  ]);
  await alice.engine.call('mergePending', [CONVERSATION]);
  const commit = inbound(alice, created.commit, 'commit');
  await bob.engine.call('join', [CONVERSATION, created.welcome!, [ALICE], commit.seq]);
  return { alice, bob, commit };
}

describe('groups (roles in the encryption state)', () => {
  it('carries the policy to members and tags messages with the sender’s authority', async () => {
    seq = 0;
    const alice = await device(ALICE);
    const bob = await device(BOB);
    await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey!, 1]);
    await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey!, 1]);
    const [keyPackage] = await bob.engine.call('keyPackages', [1, false]);
    const policy = {
      v: 1 as const,
      owner: ALICE,
      admins: [],
      membersCanAdd: false,
      membersCanEditInfo: false,
      announcementsOnly: false,
    };
    // Only the owner can create a group with a policy.
    await expect(
      bob.engine.call('createGroup', [CONVERSATION, [], [ALICE], { ...policy }]),
    ).rejects.toThrow(CryptoError);
    const created = await alice.engine.call('createGroup', [
      CONVERSATION,
      [keyPackage!],
      [BOB],
      policy,
    ]);
    await alice.engine.call('mergePending', [CONVERSATION]);
    const commit = inbound(alice, created.commit, 'commit');
    await bob.engine.call('join', [CONVERSATION, created.welcome!, [ALICE], commit.seq]);
    expect(await bob.engine.call('groupPolicy', [CONVERSATION])).toEqual(policy);

    const { ciphertext } = await bob.engine.call('encrypt', [CONVERSATION, '{"x":1}']);
    const fromBob = await alice.engine.call('ingest', [
      CONVERSATION,
      inbound(bob, ciphertext),
      [BOB],
    ]);
    expect(fromBob).toMatchObject({
      status: 'application',
      record: { authority: { role: 'member', editInfo: false, add: false } },
    });

    // A member cannot promote themselves; the owner can promote them.
    await expect(
      bob.engine.call('updatePolicy', [CONVERSATION, { ...policy, admins: [BOB] }, [ALICE]]),
    ).rejects.toThrow(CryptoError);
    const promote = await alice.engine.call('updatePolicy', [
      CONVERSATION,
      { ...policy, admins: [BOB] },
      [BOB],
    ]);
    await alice.engine.call('mergePending', [CONVERSATION]);
    expect(
      await bob.engine.call('ingest', [
        CONVERSATION,
        inbound(alice, promote.commit, 'commit'),
        [ALICE],
      ]),
    ).toMatchObject({ status: 'commit' });
    expect((await bob.engine.call('groupPolicy', [CONVERSATION]))?.admins).toEqual([BOB]);
    const own = await bob.engine.call('recordOwn', [
      CONVERSATION,
      {
        seq: 99,
        senderUserId: BOB,
        senderDeviceId: bob.identity.deviceId,
        serverTime: new Date().toISOString(),
        clientMessageId: 'own',
        content: '{}',
      },
    ]);
    expect(own.authority).toEqual({ role: 'admin', editInfo: true, add: true });
  });

  it('has no policy (and no authority) in 1:1 conversations', async () => {
    const { alice, bob } = await conversation();
    expect(await bob.engine.call('groupPolicy', [CONVERSATION])).toBeNull();
    const { ciphertext } = await alice.engine.call('encrypt', [CONVERSATION, '{}']);
    const result = await bob.engine.call('ingest', [
      CONVERSATION,
      inbound(alice, ciphertext),
      [ALICE],
    ]);
    expect(result.status === 'application' && result.record.authority).toBeUndefined();
  });
});

describe('group-call keys (ADR-047)', () => {
  it('gives both members the same per-call secret and distinct sender indexes', async () => {
    const { alice, bob } = await conversation();
    const call = '0192f0c1-7a3b-7c4d-8e5f-0000000ca11a';
    const a = await alice.engine.call('callSecret', [CONVERSATION, call, 16]);
    const b = await bob.engine.call('callSecret', [CONVERSATION, call, 16]);
    expect(a.secret).toBe(b.secret);
    expect(atob(a.secret)).toHaveLength(16);
    expect(a.ownIndex).not.toBe(b.ownIndex);
    expect(a.members.find((m) => m.index === b.ownIndex)?.deviceId).toBe(bob.identity.deviceId);
    const other = await alice.engine.call('callSecret', [
      CONVERSATION,
      '0192f0c1-7a3b-7c4d-8e5f-0000000ca11b',
      16,
    ]);
    expect(other.secret).not.toBe(a.secret);
  });
});

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
    // Franking commitment and tag are kept with the record (for verifiable reports).
    const franked = {
      ...inbound(alice, (await alice.engine.call('encrypt', [CONVERSATION, content])).ciphertext),
      commitment: 'c'.repeat(43) + '=',
      frankingTag: 'f1.tag',
    };
    expect(await restarted.call('ingest', [CONVERSATION, franked, [ALICE]])).toMatchObject({
      status: 'application',
      record: { franking: { commitment: 'c'.repeat(43) + '=', tag: 'f1.tag' } },
    });
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
    await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey!, 1]);
    await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey!, 1]);
    const [bobPackage] = await bob.engine.call('keyPackages', [1, false]);
    const [alicePackage] = await alice.engine.call('keyPackages', [1, false]);
    // Both create the group at once; the server accepts Alice's commit.
    const fromAlice = await alice.engine.call('createGroup', [
      CONVERSATION,
      [bobPackage!],
      [BOB],
      null,
    ]);
    await bob.engine.call('createGroup', [CONVERSATION, [alicePackage!], [ALICE], null]);
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
    await alice.engine.call('observeIdentity', [BOB, bob.identity.askPublicKey!, 1]);
    await bob.engine.call('observeIdentity', [ALICE, alice.identity.askPublicKey!, 1]);
    const [bobPackage] = await bob.engine.call('keyPackages', [1, false]);
    const [alicePackage] = await alice.engine.call('keyPackages', [1, false]);
    const fromAlice = await alice.engine.call('createGroup', [
      CONVERSATION,
      [bobPackage!],
      [BOB],
      null,
    ]);
    await bob.engine.call('createGroup', [CONVERSATION, [alicePackage!], [ALICE], null]);
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

describe('multi-device (docs/multi-device.md)', () => {
  it('links a new device with its history; the result survives a restart', async () => {
    const { alice, bob } = await conversation();
    const content = JSON.stringify({ v: 1, text: 'before the laptop' });
    const sent = await bob.engine.call('encrypt', [CONVERSATION, content]);
    await alice.engine.call('ingest', [CONVERSATION, inbound(bob, sent.ciphertext), [BOB]]);

    const factory = new IDBFactory();
    const laptop = new CryptoEngine(core, factory);
    expect(await laptop.call('init', [ALICE])).toEqual({ identity: null });
    const pending = await laptop.call('createPending', [ALICE]);
    expect(pending).toMatchObject({ pending: true, trusted: false, askPublicKey: null });
    const keys = await laptop.call('linkRequest', []);
    const shortId = btoa('\x01\x02\x03\x04\x05');
    const code = await laptop.call('linkCode', [shortId]);
    expect(await alice.engine.call('parseLinkCode', [code])).toBe(shortId);

    // A mistyped code, or keys the server substituted, are refused before anything is sent.
    await alice.engine.call('verifyLinkCode', [
      code,
      shortId,
      keys.hpkePublic,
      keys.signaturePublic,
    ]);
    await expect(
      alice.engine.call('verifyLinkCode', [code, shortId, keys.signaturePublic, keys.hpkePublic]),
    ).rejects.toMatchObject({ code: 'UNTRUSTED' });
    const typo = code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(
      alice.engine.call('approveLink', [
        typo,
        shortId,
        pending.deviceId,
        keys.hpkePublic,
        keys.signaturePublic,
        true,
        true,
      ]),
    ).rejects.toBeInstanceOf(CryptoError);

    const sealed = await alice.engine.call('approveLink', [
      code,
      shortId,
      pending.deviceId,
      keys.hpkePublic,
      keys.signaturePublic,
      true,
      true,
    ]);
    const linked = await laptop.call('completeLink', [
      sealed,
      shortId,
      alice.identity.askPublicKey!,
      1,
    ]);
    expect(linked).toMatchObject({
      pending: false,
      trusted: true,
      askPublicKey: alice.identity.askPublicKey,
    });
    expect((await laptop.call('history', [CONVERSATION])).map((r) => r.content)).toEqual([content]);
    // Contacts pinned on the old device are pinned here too.
    expect(await laptop.call('pin', [BOB])).toMatchObject({ key: bob.identity.askPublicKey });

    const reopened = new CryptoEngine(core, factory);
    expect((await reopened.call('init', [ALICE])).identity).toEqual(linked);
    expect(await reopened.call('history', [CONVERSATION])).toHaveLength(1);

    // Forgetting the device deletes everything local.
    await reopened.call('reset', [ALICE]);
    const again = new CryptoEngine(core, factory);
    expect(await again.call('init', [ALICE])).toEqual({ identity: null });
  });

  it('backs up and restores identity, contacts and history; only the right key unlocks it', async () => {
    const { alice, bob } = await conversation();
    const content = JSON.stringify({ v: 1, text: 'keep me' });
    const sent = await bob.engine.call('encrypt', [CONVERSATION, content]);
    await alice.engine.call('ingest', [CONVERSATION, inbound(bob, sent.ciphertext), [BOB]]);
    await alice.engine.call('setVerified', [BOB, true]);

    const { recoveryKey, wrap } = await alice.engine.call('backupEnable', []);
    expect(recoveryKey.replaceAll('-', '')).toHaveLength(52);
    const backup = await alice.engine.call('backupExport', [1]);
    expect(await alice.engine.call('backupOwns', [backup.manifest, backup.mac])).toBe(true);
    // The server only ever sees ciphertext.
    expect(atob(backup.blob)).not.toContain('keep me');

    const fresh = async () => {
      const engine = new CryptoEngine(core, new IDBFactory());
      await engine.call('init', [ALICE]);
      await engine.call('createPending', [ALICE]);
      return engine;
    };
    const wrong = await fresh();
    await expect(
      wrong.call('backupRestore', [
        'recovery',
        'AAAA-'.repeat(12) + 'AAAA',
        wrap,
        backup,
        alice.identity.askPublicKey!,
        1,
      ]),
    ).rejects.toMatchObject({ code: 'UNTRUSTED' });

    const restored = await fresh();
    const result = await restored.call('backupRestore', [
      'recovery',
      recoveryKey.toLowerCase(),
      wrap,
      backup,
      alice.identity.askPublicKey!,
      1,
    ]);
    expect(result.version).toBe(1);
    expect(result.identity).toMatchObject({ trusted: true, backups: true, pending: false });
    expect(await restored.call('pin', [BOB])).toMatchObject({ verified: true });
    expect((await restored.call('history', [CONVERSATION])).map((r) => r.content)).toEqual([
      content,
    ]);
    // A device that turned backups on again separately does not own this backup.
    const other = await device(ALICE);
    await other.engine.call('backupEnable', []);
    expect(await other.engine.call('backupOwns', [backup.manifest, backup.mac])).toBe(false);
  });
});

describe('attachments (docs/media.md)', () => {
  it('encrypts files in slices and only returns plaintext that matches the message', async () => {
    const { engine } = await device(ALICE);
    for (const size of [0, 1000, 64 * 1024, 3 * 1024 * 1024 + 17]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 251);
      const { ciphertext, digest } = await engine.call('mediaEncrypt', [new Blob([bytes])]);
      expect(ciphertext.size).toBe(digest.ciphertextSize);
      expect(digest.plaintextSize).toBe(size);
      const plain = await engine.call('mediaDecrypt', [ciphertext, digest, 'image/png']);
      expect(plain.type).toBe('image/png');
      // Buffer comparison: a deep equality over megabytes is very slow.
      expect(Buffer.from(await plain.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    }
    const { ciphertext, digest } = await engine.call('mediaEncrypt', [
      new Blob([new Uint8Array(200_000).fill(3)]),
    ]);
    const bytes = new Uint8Array(await ciphertext.arrayBuffer());
    const tampered = bytes.slice();
    tampered[100_000] = (tampered[100_000] ?? 0) ^ 1;
    // Modified, truncated, a different key, or a digest for other content: all refused.
    await expect(
      engine.call('mediaDecrypt', [new Blob([tampered]), digest, 'x']),
    ).rejects.toMatchObject({ code: 'UNTRUSTED' });
    await expect(
      engine.call('mediaDecrypt', [new Blob([bytes.slice(0, -10)]), digest, 'x']),
    ).rejects.toBeInstanceOf(CryptoError);
    const other = await engine.call('mediaEncrypt', [new Blob([new Uint8Array(200_000).fill(4)])]);
    await expect(
      engine.call('mediaDecrypt', [ciphertext, { ...digest, key: other.digest.key }, 'x']),
    ).rejects.toMatchObject({ code: 'UNTRUSTED' });
    await expect(
      engine.call('mediaDecrypt', [
        ciphertext,
        { ...digest, plaintextSha256: other.digest.plaintextSha256 },
        'x',
      ]),
    ).rejects.toMatchObject({ code: 'UNTRUSTED' });
    // Two encryptions of the same file share nothing (fresh key and nonce each time).
    const again = await engine.call('mediaEncrypt', [new Blob([new Uint8Array(200_000).fill(3)])]);
    expect(again.digest.key).not.toBe(digest.key);
    expect(again.digest.ciphertextSha256).not.toBe(digest.ciphertextSha256);
  }, 30_000);

  it('caches downloaded ciphertext on the device', async () => {
    const { engine } = await device(ALICE);
    expect(await engine.call('mediaCached', ['b1'])).toBeNull();
    await engine.call('mediaCache', ['b1', new Blob([new Uint8Array([1, 2, 3])])]);
    const cached = await engine.call('mediaCached', ['b1']);
    expect(new Uint8Array(await cached!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
