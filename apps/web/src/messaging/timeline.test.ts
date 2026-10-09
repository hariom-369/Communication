import { describe, expect, it } from 'vitest';

import type { MessageBody } from './content.js';
import {
  addPending,
  callEntryId,
  applyIncoming,
  deliveryState,
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  emptyTimeline,
  setStatus,
  unreadCount,
  type TimelineState,
} from './timeline.js';

const T0 = 1_800_000_000_000;
let seq = 0;

function incoming(
  state: TimelineState,
  senderId: string,
  id: string,
  body: MessageBody,
  serverTime = T0,
): TimelineState {
  seq += 1;
  return applyIncoming(state, {
    seq,
    senderId,
    serverTime,
    clientMessageId: id,
    content: { v: 1, id, sentAt: serverTime, body },
  });
}

describe('timeline ordering', () => {
  it('orders accepted messages by seq and keeps pending ones last', () => {
    seq = 0;
    let state = addPending(emptyTimeline, {
      id: 'mine',
      senderId: 'me',
      sentAt: T0,
      text: 'hi',
      replyTo: null,
    });
    state = incoming(state, 'bob', 'b1', { kind: 'text', text: 'hello' });
    state = incoming(state, 'bob', 'b2', { kind: 'text', text: 'again' });
    expect(state.order).toEqual(['b1', 'b2', 'mine']);
  });

  it('confirms a pending message when its echo arrives, and ingests each seq once', () => {
    seq = 0;
    let state = addPending(emptyTimeline, {
      id: 'm1',
      senderId: 'me',
      sentAt: T0,
      text: 'hi',
      replyTo: null,
    });
    state = setStatus(state, 'm1', 'queued');
    expect(state.byId['m1']?.status).toBe('queued');
    const echo = {
      seq: 5,
      senderId: 'me',
      serverTime: T0,
      clientMessageId: 'm1',
      content: { v: 1 as const, id: 'm1', sentAt: T0, body: { kind: 'text' as const, text: 'hi' } },
    };
    state = applyIncoming(state, echo);
    expect(state.byId['m1']).toMatchObject({ seq: 5, status: null });
    expect(applyIncoming(state, echo)).toBe(state);
  });

  it('does not let another sender overwrite a message by reusing its id', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'shared-id', { kind: 'text', text: 'original' });
    state = incoming(state, 'mallory', 'shared-id', { kind: 'text', text: 'forged' });
    expect(state.byId['shared-id']).toMatchObject({ text: 'original', senderId: 'alice' });
  });

  it('keeps undecodable messages visible as placeholders', () => {
    const state = applyIncoming(emptyTimeline, {
      seq: 1,
      senderId: 'bob',
      serverTime: T0,
      clientMessageId: 'x',
      content: null,
    });
    expect(state.byId['x']).toMatchObject({ undecodable: true, seq: 1 });
  });
});

describe('edits and deletions', () => {
  it('allows the sender to edit within the window only', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'm', { kind: 'text', text: 'teh' });
    state = incoming(
      state,
      'bob',
      'e1',
      { kind: 'edit', target: 'm', text: 'hijacked' },
      T0 + 1000,
    );
    expect(state.byId['m']?.text).toBe('teh');
    state = incoming(state, 'alice', 'e2', { kind: 'edit', target: 'm', text: 'the' }, T0 + 1000);
    expect(state.byId['m']).toMatchObject({ text: 'the', edited: true });
    state = incoming(
      state,
      'alice',
      'e3',
      { kind: 'edit', target: 'm', text: 'late' },
      T0 + EDIT_WINDOW_MS + 1,
    );
    expect(state.byId['m']?.text).toBe('the');
  });

  it('allows the sender to delete for everyone within the window only', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'm', { kind: 'text', text: 'oops' });
    state = incoming(state, 'bob', 'd1', { kind: 'delete', target: 'm' }, T0 + 1);
    expect(state.byId['m']?.deleted).toBe(false);
    state = incoming(
      state,
      'alice',
      'd2',
      { kind: 'delete', target: 'm' },
      T0 + DELETE_WINDOW_MS + 1,
    );
    expect(state.byId['m']?.deleted).toBe(false);
    state = incoming(state, 'alice', 'd3', { kind: 'delete', target: 'm' }, T0 + 60_000);
    expect(state.byId['m']).toMatchObject({ deleted: true, text: '' });
    state = incoming(
      state,
      'alice',
      'e',
      { kind: 'edit', target: 'm', text: 'resurrect' },
      T0 + 61_000,
    );
    expect(state.byId['m']?.deleted).toBe(true);
  });
});

describe('reactions', () => {
  it('keeps one reaction per member, latest wins, null removes', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'm', { kind: 'text', text: 'lunch?' });
    state = incoming(state, 'bob', 'r1', { kind: 'reaction', target: 'm', emoji: '👍' });
    state = incoming(state, 'bob', 'r2', { kind: 'reaction', target: 'm', emoji: '❤️' });
    state = incoming(state, 'carol', 'r3', { kind: 'reaction', target: 'm', emoji: '😂' });
    expect(state.byId['m']?.reactions).toEqual({ bob: '❤️', carol: '😂' });
    state = incoming(state, 'bob', 'r4', { kind: 'reaction', target: 'm', emoji: null });
    expect(state.byId['m']?.reactions).toEqual({ carol: '😂' });
  });
});

describe('read markers and delivery state', () => {
  it('moves read markers forward only and never beyond the marker message', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'm1', { kind: 'text', text: 'a' }); // seq 1
    state = incoming(state, 'bob', 'rd1', { kind: 'read', upToSeq: 1 }); // seq 2
    state = incoming(state, 'bob', 'rd2', { kind: 'read', upToSeq: 99 }); // seq 3, clamped to 3
    expect(state.readBy['bob']).toBe(3);
    state = incoming(state, 'bob', 'rd3', { kind: 'read', upToSeq: 1 });
    expect(state.readBy['bob']).toBe(3);
  });

  it('derives delivery states and respects read-receipt reciprocity', () => {
    seq = 0;
    let state = addPending(emptyTimeline, {
      id: 'p',
      senderId: 'me',
      sentAt: T0,
      text: 'x',
      replyTo: null,
    });
    expect(deliveryState(state.byId['p']!, { deliveredUpTo: 0, readUpTo: 0 }, true)).toBe(
      'sending',
    );
    state = setStatus(state, 'p', 'failed');
    expect(deliveryState(state.byId['p']!, { deliveredUpTo: 0, readUpTo: 0 }, true)).toBe('failed');
    state = incoming(emptyTimeline, 'me', 'm', { kind: 'text', text: 'x' });
    const message = state.byId['m']!;
    expect(deliveryState(message, { deliveredUpTo: 0, readUpTo: 0 }, true)).toBe('sent');
    expect(deliveryState(message, { deliveredUpTo: 1, readUpTo: 0 }, true)).toBe('delivered');
    expect(deliveryState(message, { deliveredUpTo: 1, readUpTo: 1 }, true)).toBe('read');
    expect(deliveryState(message, { deliveredUpTo: 1, readUpTo: 1 }, false)).toBe('delivered');
  });

  it('counts unread messages from others after my read marker', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'bob', 'b1', { kind: 'text', text: '1' });
    state = incoming(state, 'bob', 'b2', { kind: 'text', text: '2' });
    state = incoming(state, 'me', 'm1', { kind: 'text', text: 'mine' });
    expect(unreadCount(state, 'me')).toBe(2);
    state = incoming(state, 'me', 'rd', { kind: 'read', upToSeq: 1 });
    expect(unreadCount(state, 'me')).toBe(1);
  });
});

describe('attachments', () => {
  it('shows media messages with their caption and removes the attachment on delete', () => {
    const attachment = {
      media: {
        blobId: 'b1',
        key: 'k',
        plaintextSha256: 'p',
        ciphertextSha256: 'c',
        plaintextSize: 1,
        ciphertextSize: 40,
      },
      category: 'image' as const,
      mime: 'image/jpeg',
      name: 'cat.jpg',
    };
    let state = applyIncoming(emptyTimeline, {
      seq: 1,
      senderId: 'peer',
      serverTime: 1000,
      clientMessageId: 'm1',
      content: { v: 1, id: 'm1', sentAt: 1, body: { kind: 'media', attachment, caption: 'look' } },
    });
    expect(state.byId['m1']).toMatchObject({ text: 'look', attachment });
    state = applyIncoming(state, {
      seq: 2,
      senderId: 'peer',
      serverTime: 2000,
      clientMessageId: 'd1',
      content: { v: 1, id: 'd1', sentAt: 2, body: { kind: 'delete', target: 'm1' } },
    });
    expect(state.byId['m1']).toMatchObject({ deleted: true, attachment: null, text: '' });
  });
});

describe('call history (docs/calling.md §2)', () => {
  const CALL = '0192f0c1-7a3b-7c4d-8e5f-0000000ca110';
  const call = (
    signal: 'offer' | 'answer' | 'end' | 'update' | 'group',
    extra = {},
  ): MessageBody => ({
    kind: 'call',
    callId: CALL,
    signal,
    media: 'video',
    sdp: signal === 'offer' || signal === 'answer' ? 'v=0' : undefined,
    ...extra,
  });

  it('shows one entry per call, answered and ended from its own signalling', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'o1', call('offer'), T0);
    state = incoming(state, 'bob', 'a1', call('answer'), T0 + 2_000);
    state = incoming(state, 'alice', 'u1', call('update'), T0 + 5_000);
    state = incoming(state, 'bob', 'e1', call('end', { reason: 'hangup' }), T0 + 65_000);
    expect(state.order).toEqual([callEntryId(CALL)]);
    const entry = state.byId[callEntryId(CALL)]!;
    expect(entry.senderId).toBe('alice');
    expect(entry.call).toMatchObject({
      media: 'video',
      group: false,
      answeredAt: T0 + 2_000,
      endedAt: T0 + 65_000,
      endReason: 'hangup',
    });
    // A late or replayed signal changes nothing once the call ended.
    const after = incoming(state, 'bob', 'a2', call('answer'), T0 + 70_000);
    expect(after.byId[callEntryId(CALL)]).toEqual(entry);
  });

  it('records a missed call, and the caller cannot mark its own call answered', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'alice', 'o1', call('offer'), T0);
    state = incoming(state, 'alice', 'a1', call('answer'), T0 + 1_000);
    expect(state.byId[callEntryId(CALL)]!.call!.answeredAt).toBeNull();
    state = incoming(state, 'alice', 'e1', call('end', { reason: 'missed' }), T0 + 30_000);
    expect(state.byId[callEntryId(CALL)]!.call).toMatchObject({
      answeredAt: null,
      endReason: 'missed',
    });
    // A second offer with the same call id (from someone else) cannot take over the entry.
    const hijack = incoming(state, 'mallory', 'o2', call('offer'), T0 + 31_000);
    expect(hijack.byId[callEntryId(CALL)]!.senderId).toBe('alice');
  });

  it('announces group calls without ending them on one person leaving', () => {
    seq = 0;
    let state = incoming(emptyTimeline, 'ana', 'g1', call('group'), T0);
    state = incoming(state, 'raj', 'e1', call('end'), T0 + 10_000);
    expect(state.byId[callEntryId(CALL)]!.call).toMatchObject({ group: true, endedAt: null });
  });
});
