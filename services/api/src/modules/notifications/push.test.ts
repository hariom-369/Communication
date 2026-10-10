import { PUSH_PAYLOAD_BYTES, pushPayloadSchema } from '@tessera/validation';
import { describe, expect, it } from 'vitest';

import {
  SafeFetchError,
  safePost,
  type SafePostTransport,
} from '../../platform/safe-fetch/index.js';

import { inQuietHours, localMinutes } from './notifications.js';
import { encodePayload, PushSender, pushTopic } from './push.js';
import { entryKey, parseEntry } from './queue.js';

const ID = '01a1226a-72af-77cb-a523-db3dbdf394d6';

describe('push payloads', () => {
  it('pads every kind of payload to the same size', () => {
    const encoded = [
      encodePayload({ t: 'sync', c: ID }),
      encodePayload({ t: 'call', c: ID, k: ID }),
      encodePayload({ t: 'channel', c: ID }),
      encodePayload({ t: 'alert' }),
    ];
    for (const payload of encoded) {
      expect(Buffer.byteLength(payload)).toBe(PUSH_PAYLOAD_BYTES);
      expect(pushPayloadSchema.safeParse(JSON.parse(payload)).success).toBe(true);
    }
  });

  it('derives topics per subscription', () => {
    const a = pushTopic(Buffer.alloc(16, 1), ID);
    const b = pushTopic(Buffer.alloc(16, 2), ID);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
    expect(pushTopic(Buffer.alloc(16, 1), ID)).toBe(a);
  });
});

describe('quiet hours', () => {
  const at = (iso: string) => new Date(iso);
  it('handles windows within a day and across midnight, in the person’s time zone', () => {
    expect(localMinutes(at('2026-01-15T12:30:00Z'), 'UTC')).toBe(750);
    expect(localMinutes(at('2026-01-15T12:30:00Z'), 'Asia/Kolkata')).toBe(18 * 60);
    const day = { start: 9 * 60, end: 17 * 60, timeZone: 'UTC', allowCalls: true };
    expect(inQuietHours(day, at('2026-01-15T12:00:00Z'))).toBe(true);
    expect(inQuietHours(day, at('2026-01-15T17:00:00Z'))).toBe(false);
    const night = { start: 22 * 60, end: 7 * 60, timeZone: 'Europe/Berlin', allowCalls: true };
    expect(inQuietHours(night, at('2026-01-15T22:30:00Z'))).toBe(true); // 23:30 in Berlin
    expect(inQuietHours(night, at('2026-01-15T05:30:00Z'))).toBe(true); // 06:30
    expect(inQuietHours(night, at('2026-01-15T06:30:00Z'))).toBe(false); // 07:30
    expect(inQuietHours(null, at('2026-01-15T05:30:00Z'))).toBe(false);
  });
});

describe('queue entries', () => {
  it('round-trips and rejects malformed keys', () => {
    const entry = { kind: 'conversation', userId: ID, id: ID } as const;
    expect(parseEntry(entryKey(entry))).toEqual(entry);
    expect(parseEntry(entryKey({ kind: 'channel', userId: ID, id: ID }))?.kind).toBe('channel');
    expect(parseEntry('x:1:2')).toBeNull();
    expect(parseEntry('m:1')).toBeNull();
  });
});

describe('push endpoints (SSRF rules)', () => {
  const sender = new PushSender({
    vapid: { publicKey: 'x', privateKey: 'y', subject: 'mailto:a@b.test' },
    allowedHosts: ['fcm.googleapis.com', 'push.apple.com'],
  });

  it('accepts only https on 443 to allow-listed push services', () => {
    expect(sender.acceptsEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(sender.acceptsEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/x',
      'https://evilfcm.googleapis.com.attacker.test/x',
      'https://evilfcm.googleapis.com/x',
      'https://notfcm.googleapis.com.evil/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'file:///etc/passwd',
      'not a url',
    ])
      expect(sender.acceptsEndpoint(endpoint), endpoint).toBe(false);
  });

  function transport(addresses: string[], status = 201) {
    const posted: string[] = [];
    const fake: SafePostTransport = {
      resolve: () => Promise.resolve(addresses),
      post: (_url, address) => {
        posted.push(address);
        return Promise.resolve(status);
      },
    };
    return { fake, posted };
  }

  it('pins a public address and refuses names that resolve to internal ones', async () => {
    const ok = transport(['142.250.1.1']);
    expect(
      await safePost(
        'https://fcm.googleapis.com/x',
        ['fcm.googleapis.com'],
        {},
        Buffer.alloc(0),
        ok.fake,
      ),
    ).toBe(201);
    expect(ok.posted).toEqual(['142.250.1.1']);
    for (const internal of [
      ['10.0.0.1'],
      ['142.250.1.1', '169.254.169.254'],
      ['::ffff:127.0.0.1'],
    ]) {
      const blocked = transport(internal);
      await expect(
        safePost(
          'https://fcm.googleapis.com/x',
          ['fcm.googleapis.com'],
          {},
          Buffer.alloc(0),
          blocked.fake,
        ),
      ).rejects.toBeInstanceOf(SafeFetchError);
      expect(blocked.posted).toEqual([]);
    }
  });
});
