import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { bundleAad, generateModerationKeyPair, ModerationKey, sealBundle } from './hpke.js';
import { canonicalHost, hostHash, hostsIn, hostVariants } from './links.js';
import { deadlines, serviceLevel } from './sla.js';

const HOUR = 3_600_000;

describe('service levels (docs/moderation.md §6)', () => {
  it.each([
    ['court_order', 1, 3, 3],
    ['government_order', 1, 3, 3],
    ['ncii', 1, 2, 2],
    ['synthetic_media', 1, 2, 2],
    ['csam', 1, 1, 24],
    ['terrorism', 2, 4, 24],
    ['violence_threat', 2, 4, 24],
    ['self_harm', 2, 4, 24],
    ['harassment', 3, 24, 168],
    ['grievance', 3, 24, 168],
    ['spam', 4, 24, 168],
  ])('%s: priority %i, acknowledge in %i h, resolve in %i h', (category, priority, ack, due) => {
    expect(serviceLevel(category).priority).toBe(priority);
    const from = new Date('2026-10-10T00:00:00Z');
    const result = deadlines(category, from);
    expect(result.ackDueAt.getTime() - from.getTime()).toBe(ack * HOUR);
    expect(result.dueAt.getTime() - from.getTime()).toBe(due * HOUR);
  });
});

describe('harmful links (docs/moderation.md §4)', () => {
  it('finds hosts in links and bare domains, normalised', () => {
    expect(
      hostsIn(
        'Go to https://WWW.Example.COM./path?x=1 or bad.example/login, not 3.14 or e.g.',
      ).sort(),
    ).toEqual(['bad.example', 'example.com']);
    expect(hostsIn('no links here')).toEqual([]);
    expect(canonicalHost('WWW.Shop.Example.')).toBe('shop.example');
  });

  it('checks every parent domain, never the bare top-level domain', () => {
    expect(hostVariants('a.b.evil.example')).toEqual([
      'a.b.evil.example',
      'b.evil.example',
      'evil.example',
    ]);
    expect(hostVariants('example')).toEqual([]);
    expect(hostHash('evil.example')).toHaveLength(32);
  });
});

describe('report bundle encryption (HPKE, RFC 9180)', () => {
  it('opens only with the matching key and binding', async () => {
    const pair = await generateModerationKeyPair();
    const key = await ModerationKey.load(pair.publicKey, pair.privateKey);
    const plaintext = randomBytes(1000);
    const aad = bundleAad('conversation-a', 'reporter-1');
    const sealed = await sealBundle(pair.publicKey, plaintext, aad);
    const open = (binding: Uint8Array) =>
      key.open(
        Buffer.from(sealed.enc, 'base64url'),
        Buffer.from(sealed.ciphertext, 'base64'),
        binding,
      );
    expect(await open(aad)).toEqual(plaintext);
    await expect(open(bundleAad('conversation-b', 'reporter-1'))).rejects.toThrow();
    await expect(open(bundleAad('conversation-a', 'reporter-2'))).rejects.toThrow();
    const other = await generateModerationKeyPair();
    const otherKey = await ModerationKey.load(other.publicKey, other.privateKey);
    await expect(
      otherKey.open(
        Buffer.from(sealed.enc, 'base64url'),
        Buffer.from(sealed.ciphertext, 'base64'),
        aad,
      ),
    ).rejects.toThrow();
    // Every bundle uses a fresh ephemeral key.
    expect((await sealBundle(pair.publicKey, plaintext, aad)).enc).not.toBe(sealed.enc);
  });
});
