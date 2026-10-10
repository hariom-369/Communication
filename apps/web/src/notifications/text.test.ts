import { describe, expect, it } from 'vitest';

import { describeBody, inQuietHours, messageNotification } from './text.js';

const item = (text: string, mentionsMe = false) => ({ sender: '@alice', text, mentionsMe });

describe('notification text (decided on the device)', () => {
  it('follows the device’s preview setting', () => {
    const base = {
      conversationTitle: 'Book club',
      isGroup: true,
      items: [item('Chapter 3 tonight')],
    };
    expect(messageNotification({ ...base, level: 'full' })).toEqual({
      title: 'Book club',
      body: '@alice: Chapter 3 tonight',
    });
    expect(messageNotification({ ...base, level: 'name' })).toEqual({
      title: 'Book club',
      body: 'New message',
    });
    expect(messageNotification({ ...base, level: 'none' })).toEqual({
      title: 'Tessera',
      body: 'New message',
    });
  });

  it('summarises bursts, flags mentions and shortens long text', () => {
    const shown = messageNotification({
      conversationTitle: '@bob',
      isGroup: false,
      items: [item('one'), item('two', true), item('x'.repeat(400))],
      level: 'full',
    });
    expect(shown.title).toBe('@bob · mentioned you');
    expect(shown.body.startsWith('(3) x')).toBe(true);
    expect(shown.body.length).toBeLessThanOrEqual(160);
    expect(
      messageNotification({
        conversationTitle: '@bob',
        isGroup: false,
        items: [item('a'), item('b')],
        level: 'name',
      }).body,
    ).toBe('2 new messages');
  });

  it('notifies for messages people read, not for reactions, edits or call signals', () => {
    expect(describeBody({ kind: 'text', text: 'hi' })).toBe('hi');
    expect(
      describeBody({ kind: 'poll', question: 'Dune?', options: ['y', 'n'], multiple: false }),
    ).toBe('Poll: Dune?');
    expect(describeBody({ kind: 'reaction', target: 'm1', emoji: '👍' } as never)).toBeNull();
    expect(describeBody({ kind: 'edit', target: 'm1', text: 'x' } as never)).toBeNull();
    expect(
      describeBody({ kind: 'call', callId: 'c', signal: 'offer', media: 'audio' } as never),
    ).toBeNull();
  });

  it('applies quiet hours in the chosen time zone, including across midnight', () => {
    const night = { start: 22 * 60, end: 7 * 60, timeZone: 'Asia/Kolkata' };
    expect(inQuietHours(night, new Date('2026-01-15T17:00:00Z'))).toBe(true); // 22:30 IST
    expect(inQuietHours(night, new Date('2026-01-15T00:30:00Z'))).toBe(true); // 06:00 IST
    expect(inQuietHours(night, new Date('2026-01-15T02:00:00Z'))).toBe(false); // 07:30 IST
    expect(inQuietHours(null)).toBe(false);
  });
});
