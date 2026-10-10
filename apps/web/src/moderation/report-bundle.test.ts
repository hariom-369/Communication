import { reportBundleAad, reportBundleSchema, REPORT_HPKE_INFO } from '@tessera/validation';
import { describe, expect, it } from 'vitest';

import type { HistoryRecord } from '../crypto/protocol.js';

import { buildBundle, ReportTooLarge, sealBundle, suite } from './report-bundle.js';

const record = (seq: number, content: string | null, franked = true): HistoryRecord => ({
  seq,
  senderUserId: seq % 2 === 0 ? 'bob' : 'alice',
  senderDeviceId: 'device',
  serverTime: new Date(seq * 1000).toISOString(),
  clientMessageId: `m${seq}`,
  content,
  ...(franked ? { franking: { commitment: `c${seq}`, tag: `f1.t${seq}` } } : {}),
});

const history = [
  record(1, '{"a":1}'),
  record(2, null),
  record(3, '{"a":3}', false),
  record(4, '{"a":4}'),
  record(5, '{"a":5}'),
  record(6, '{"a":6}'),
];

describe('report bundles', () => {
  it('carries the selected messages and the chosen amount of earlier context, verbatim', () => {
    const bundle = buildBundle({
      conversationId: 'c1',
      reporterId: 'alice',
      history,
      selected: [4, 6],
      context: 2,
    });
    expect(bundle.messages.map((m) => [m.seq, m.selected])).toEqual([
      [1, false],
      [3, false],
      [4, true],
      [6, true],
    ]);
    expect(bundle.messages[2]).toMatchObject({
      plaintext: '{"a":4}',
      commitment: 'c4',
      frankingTag: 'f1.t4',
    });
    // Unfranked (older) messages go as they are; the server marks them unverified.
    expect(bundle.messages[1]).toMatchObject({ commitment: null, frankingTag: null });
    expect(reportBundleSchema.safeParse(bundle).success).toBe(true);
    expect(() =>
      buildBundle({
        conversationId: 'c1',
        reporterId: 'alice',
        history,
        selected: [2],
        context: 0,
      }),
    ).toThrow('Choose at least one message');
  });

  it('seals to the moderation key, bound to the conversation and the reporter', async () => {
    const pair = await suite.kem.generateKeyPair();
    const publicKey = btoa(
      String.fromCharCode(...new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey))),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    const bundle = buildBundle({
      conversationId: 'c1',
      reporterId: 'alice',
      history,
      selected: [5],
      context: 0,
      files: [{ seq: 5, name: 'a.jpg', mime: 'image/jpeg', data: new Uint8Array([1, 2, 3]) }],
    });
    const sealed = await sealBundle(publicKey, bundle);
    const decode = (value: string, url = false) =>
      Uint8Array.from(atob(url ? value.replaceAll('-', '+').replaceAll('_', '/') : value), (char) =>
        char.charCodeAt(0),
      );
    const open = (aad: string) =>
      suite.open(
        {
          recipientKey: pair.privateKey,
          enc: decode(sealed.enc, true),
          info: new TextEncoder().encode(REPORT_HPKE_INFO),
        },
        decode(sealed.ciphertext),
        new TextEncoder().encode(aad),
      );
    const opened = JSON.parse(
      new TextDecoder().decode(await open(reportBundleAad('c1', 'alice'))),
    ) as unknown;
    expect(opened).toEqual(bundle);
    await expect(open(reportBundleAad('c2', 'alice'))).rejects.toThrow();
    await expect(open(reportBundleAad('c1', 'mallory'))).rejects.toThrow();
  });

  it('refuses bundles over the size limit before sending anything', async () => {
    const bundle = buildBundle({
      conversationId: 'c1',
      reporterId: 'alice',
      history,
      selected: [5],
      context: 0,
      files: [{ seq: 5, name: 'big', mime: 'video/mp4', data: new Uint8Array(7 * 1024 * 1024) }],
    });
    await expect(sealBundle('AAAA', bundle)).rejects.toBeInstanceOf(ReportTooLarge);
  });
});
