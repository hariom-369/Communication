import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { contentSchema, type MessageContent } from './content.js';
import { frank } from './franking.js';
import { testId } from '../test/ids.js';

const content: MessageContent = {
  v: 1,
  id: testId('m1'),
  sentAt: 1,
  body: { kind: 'text', text: 'hi' },
};

describe('message franking, sender side (ADR-021)', () => {
  it('commits to the exact JSON with a fresh key carried inside it', async () => {
    const first = await frank(content);
    const parsed = contentSchema.parse(JSON.parse(first.json));
    expect(parsed).toMatchObject({
      ...content,
      f: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/) as unknown,
    });
    // The same check the server makes (services/api/src/platform/franking.ts).
    const key = Buffer.from(parsed.f ?? '', 'base64');
    expect(key).toHaveLength(32);
    expect(createHmac('sha256', key).update(first.json).digest('base64')).toBe(first.commitment);
    // A fresh key every time: two franks of the same content are unlinkable.
    const second = await frank(content);
    expect(second.commitment).not.toBe(first.commitment);
    expect(JSON.parse(second.json)).not.toEqual(JSON.parse(first.json));
  });
});
