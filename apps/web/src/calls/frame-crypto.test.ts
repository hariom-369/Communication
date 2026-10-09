// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CallFrameCrypto, clearPrefixLength } from './frame-crypto.js';
import { decodeHeader, splitKeyId } from './sframe.js';

const secret = (byte: number) => new Uint8Array(16).fill(byte);
const frame = (length: number, seed = 1) =>
  Uint8Array.from({ length }, (_, i) => (i * seed) & 0xff);

/** Two members of a call in the same epoch. */
function pair(epoch = 5) {
  const alice = new CallFrameCrypto();
  const bob = new CallFrameCrypto();
  alice.setEpoch({ epoch, secret: secret(1), ownIndex: 0 });
  bob.setEpoch({ epoch, secret: secret(1), ownIndex: 1 });
  return { alice, bob };
}

describe('group-call frame encryption (ADR-047)', () => {
  it('encrypts audio completely and decrypts it for another member, attributed to the sender', async () => {
    const { alice, bob } = pair();
    const opus = frame(120);
    const sealed = (await alice.encrypt(opus, clearPrefixLength('audio', false)))!;
    expect(sealed.length).toBe(120 + 16 + decodeHeader(sealed)!.length);
    expect(Buffer.from(sealed).includes(Buffer.from(opus.subarray(0, 16)))).toBe(false);
    const opened = (await bob.decrypt(sealed, 0))!;
    expect(opened.data).toEqual(opus);
    expect(opened).toMatchObject({ senderIndex: 0, epoch: 5 });
  });

  it('keeps only the VP8 payload header in the clear, and authenticates it', async () => {
    const { alice, bob } = pair();
    const key = frame(2000, 3);
    const prefix = clearPrefixLength('video', true);
    expect(prefix).toBe(10);
    expect(clearPrefixLength('video', false)).toBe(3);
    const sealed = (await alice.encrypt(key, prefix))!;
    expect(sealed.subarray(0, 10)).toEqual(key.subarray(0, 10));
    expect(Buffer.from(sealed.subarray(10)).includes(Buffer.from(key.subarray(10, 40)))).toBe(
      false,
    );
    expect((await bob.decrypt(sealed, prefix))!.data).toEqual(key);
    // Changing the clear header (e.g. turning a delta frame into a "key frame") is detected.
    const tampered = sealed.slice();
    tampered[0]! ^= 0x01;
    expect(await bob.decrypt(tampered, prefix)).toBeNull();
  });

  it('never reuses a counter, and each sender has its own key', async () => {
    const { alice, bob } = pair();
    const counters = new Set<bigint>();
    for (let i = 0; i < 50; i += 1) {
      const sealed = (await alice.encrypt(frame(30, i), 0))!;
      counters.add(decodeHeader(sealed)!.ctr);
    }
    expect(counters.size).toBe(50);
    const fromAlice = decodeHeader((await alice.encrypt(frame(30), 0))!)!;
    const fromBob = decodeHeader((await bob.encrypt(frame(30), 0))!)!;
    expect(splitKeyId(fromAlice.kid).senderIndex).toBe(0);
    expect(splitKeyId(fromBob.kid).senderIndex).toBe(1);
    expect(fromAlice.kid).not.toBe(fromBob.kid);
  });

  it('re-keys on a new epoch; a removed member cannot read the new epoch', async () => {
    const { alice, bob } = pair(5);
    const carol = new CallFrameCrypto();
    carol.setEpoch({ epoch: 5, secret: secret(1), ownIndex: 2 });
    const before = (await alice.encrypt(frame(40), 0))!;
    expect(await carol.decrypt(before, 0)).not.toBeNull();

    // Carol is removed: Alice and Bob move to epoch 6, whose secret Carol never learns.
    alice.setEpoch({ epoch: 6, secret: secret(2), ownIndex: 0 });
    const after = (await alice.encrypt(frame(40), 0))!;
    expect(decodeHeader(after)!.ctr).toBe(0n); // new key, new counter
    expect(await carol.decrypt(after, 0)).toBeNull();
    // Bob has not processed the commit yet: he cannot read epoch 6 until he does…
    expect(await bob.decrypt(after, 0)).toBeNull();
    bob.setEpoch({ epoch: 6, secret: secret(2), ownIndex: 1 });
    expect((await bob.decrypt(after, 0))!.epoch).toBe(6);
    // …and frames still in flight from epoch 5 keep playing during the overlap.
    expect((await bob.decrypt(before, 0))!.epoch).toBe(5);
  });

  it('drops frames without keys, without encryption, or from outside the call', async () => {
    const lonely = new CallFrameCrypto();
    expect(await lonely.encrypt(frame(10), 0)).toBeNull();
    const { alice, bob } = pair();
    // An unencrypted frame (e.g. injected by the SFU) never reaches the decoder.
    expect(await bob.decrypt(frame(200, 5), 0)).toBeNull();
    expect(await bob.decrypt(new Uint8Array(0), 0)).toBeNull();
    // A participant with another secret (not in the MLS group) is not accepted.
    const outsider = new CallFrameCrypto();
    outsider.setEpoch({ epoch: 5, secret: secret(9), ownIndex: 3 });
    expect(await bob.decrypt((await outsider.encrypt(frame(50), 0))!, 0)).toBeNull();
    expect(() => alice.setEpoch({ epoch: 7, secret: new Uint8Array(8), ownIndex: 0 })).toThrow(
      RangeError,
    );
  });
});
