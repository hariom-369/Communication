import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { commitmentOpens, FrankingTagger, type FrankedMessage } from './franking.js';
import { parseKeyring } from './secrets.js';

const key = (): string => randomBytes(32).toString('base64');
const message: FrankedMessage = {
  conversationId: '0d0f3f8e-6b1b-4c49-9a52-0d6c1d5b8e01',
  seq: 42,
  senderUserId: '1b9a7c55-2f9e-4b8f-8a4e-5c1d2e3f4a5b',
  senderDeviceId: '2c8b6d44-3e8f-4c7e-9b3d-6d2e3f4a5b6c',
  clientMessageId: '3d7c5e33-4f7e-4d6d-8c2c-7e3f4a5b6c7d',
  serverTime: '2026-10-10T08:00:00.000Z',
};

describe('message franking (ADR-021)', () => {
  it('binds the commitment to every delivery field', () => {
    const tagger = new FrankingTagger(parseKeyring(`f1:${key()}`));
    const commitment = randomBytes(32);
    const tag = tagger.tag(commitment, message);
    expect(tag).toMatch(/^f1\.[A-Za-z0-9_-]{43}$/);
    expect(tagger.verify(tag, commitment, message)).toBe(true);
    expect(tagger.verify(tag, randomBytes(32), message)).toBe(false);
    for (const field of Object.keys(message) as (keyof FrankedMessage)[]) {
      const changed = { ...message, [field]: field === 'seq' ? 43 : `${message[field]}x` };
      expect(tagger.verify(tag, commitment, changed), field).toBe(false);
    }
    // Field boundaries cannot be shifted from one field into the next.
    const shifted = {
      ...message,
      senderUserId: `${message.senderUserId}${message.senderDeviceId.slice(0, 4)}`,
      senderDeviceId: message.senderDeviceId.slice(4),
    };
    expect(tagger.verify(tag, commitment, shifted)).toBe(false);
  });

  it('verifies tags from retired keys and refuses unknown keys or malformed tags', () => {
    const [oldKey, newKey] = [key(), key()];
    const commitment = randomBytes(32);
    const tag = new FrankingTagger(parseKeyring(`f1:${oldKey}`)).tag(commitment, message);
    const rotated = new FrankingTagger(parseKeyring(`f2:${newKey},f1:${oldKey}`));
    expect(rotated.verify(tag, commitment, message)).toBe(true);
    expect(rotated.tag(commitment, message).startsWith('f2.')).toBe(true);
    const other = new FrankingTagger(parseKeyring(`f1:${key()}`));
    expect(other.verify(tag, commitment, message)).toBe(false);
    for (const bad of ['', 'f1', '.abc', 'f9.abc', 'f1.'])
      expect(rotated.verify(bad, commitment, message), bad).toBe(false);
  });

  it('opens a commitment only to the exact plaintext with its key', () => {
    const f = randomBytes(32);
    const plaintext = Buffer.from('{"f":"…","body":{"kind":"text","text":"hi"}}');
    const commitment = createHmac('sha256', f).update(plaintext).digest();
    expect(commitmentOpens(commitment, f, plaintext)).toBe(true);
    expect(commitmentOpens(commitment, f, Buffer.from(`${plaintext.toString()} `))).toBe(false);
    expect(commitmentOpens(commitment, randomBytes(32), plaintext)).toBe(false);
    expect(commitmentOpens(commitment, f.subarray(0, 16), plaintext)).toBe(false);
    expect(commitmentOpens(commitment.subarray(0, 31), f, plaintext)).toBe(false);
  });
});
