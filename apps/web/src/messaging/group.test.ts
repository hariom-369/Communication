import { describe, expect, it } from 'vitest';

import type { HistoryRecord, SenderAuthority } from '../crypto/protocol.js';

import { contentSchema, type MessageBody } from './content.js';
import { INTENT_TTL_MS, intendedMembers } from './group-intents.js';
import { applyIncoming, emptyTimeline, MAX_PINS, type TimelineState } from './timeline.js';

/** Group rules every client enforces on decrypted content (docs/groups.md). */

const T0 = 1_800_000_000_000;
const OWNER: SenderAuthority = { role: 'owner', editInfo: true, add: true };
const ADMIN: SenderAuthority = { role: 'admin', editInfo: true, add: true };
const MEMBER: SenderAuthority = { role: 'member', editInfo: false, add: false };
const OPEN_MEMBER: SenderAuthority = { role: 'member', editInfo: true, add: true };
const ALICE = '0192f0c1-0000-7000-8000-0000000000a1';
const BOB = '0192f0c1-0000-7000-8000-0000000000b1';
const GHOST = '0192f0c1-0000-7000-8000-0000000000c1';

let seq = 0;
function apply(
  state: TimelineState,
  sender: string,
  authority: SenderAuthority | undefined,
  id: string,
  body: MessageBody,
  serverTime = T0,
): TimelineState {
  seq += 1;
  return applyIncoming(state, {
    seq,
    senderId: sender,
    serverTime,
    clientMessageId: id,
    content: { v: 1, id, sentAt: serverTime, body },
    authority,
  });
}

describe('group content', () => {
  it('validates the new kinds strictly', () => {
    const base = { v: 1, id: 'x', sentAt: 1 };
    const ok = [
      { kind: 'group_info', name: 'Team', description: '' },
      { kind: 'group_members', add: [ALICE], remove: [] },
      { kind: 'pin', target: 'm', pinned: true },
      { kind: 'poll', question: 'Lunch?', options: ['Yes', 'No'], multiple: false },
      { kind: 'vote', target: 'p', choices: [1] },
      { kind: 'text', text: 'hi @bob', mentions: [BOB] },
    ];
    for (const body of ok) expect(contentSchema.safeParse({ ...base, body }).success).toBe(true);
    const bad = [
      { kind: 'group_info', name: '', description: '' },
      { kind: 'group_info', name: 'x'.repeat(81), description: '' },
      { kind: 'group_members', add: ['not-a-uuid'], remove: [] },
      { kind: 'poll', question: 'Q', options: ['only one'], multiple: false },
      { kind: 'vote', target: 'p', choices: [99] },
      { kind: 'text', text: 'hi', mentions: ['bob'] },
    ];
    for (const body of bad)
      expect(contentSchema.safeParse({ ...base, body }).success, JSON.stringify(body)).toBe(false);
  });

  it('accepts name changes only from senders allowed to edit info', () => {
    seq = 0;
    let state = apply(emptyTimeline, ALICE, OWNER, 'i1', {
      kind: 'group_info',
      name: 'Team',
      description: 'd',
    });
    expect(state.group).toMatchObject({ name: 'Team', description: 'd' });
    state = apply(state, BOB, MEMBER, 'i2', {
      kind: 'group_info',
      name: 'Hacked',
      description: '',
    });
    expect(state.group.name).toBe('Team');
    state = apply(state, BOB, OPEN_MEMBER, 'i3', {
      kind: 'group_info',
      name: 'Ok',
      description: '',
    });
    expect(state.group.name).toBe('Ok');
    // 1:1 conversations have no group info at all.
    expect(
      apply(emptyTimeline, ALICE, undefined, 'i4', {
        kind: 'group_info',
        name: 'X',
        description: '',
      }).group.name,
    ).toBeNull();
  });

  it('lets a snapshot fill in a missing name but never overwrite one', () => {
    seq = 0;
    const snapshot = { kind: 'group_info' as const, name: 'Team', description: '', snapshot: true };
    let state = apply(emptyTimeline, BOB, MEMBER, 's1', snapshot);
    expect(state.group.name).toBe('Team');
    state = apply(state, BOB, MEMBER, 's2', { ...snapshot, name: 'Renamed' });
    expect(state.group.name).toBe('Team');
  });

  it('honours pins from admins only and drops pins of deleted messages', () => {
    seq = 0;
    let state = apply(emptyTimeline, ALICE, MEMBER, 'm', { kind: 'text', text: 'hello' });
    state = apply(state, BOB, MEMBER, 'p1', { kind: 'pin', target: 'm', pinned: true });
    expect(state.group.pins).toEqual([]);
    state = apply(state, BOB, ADMIN, 'p2', { kind: 'pin', target: 'm', pinned: true });
    expect(state.group.pins).toEqual(['m']);
    state = apply(state, ALICE, MEMBER, 'd', { kind: 'delete', target: 'm' }, T0 + 1);
    expect(state.group.pins).toEqual([]);
    // Pins are capped.
    for (let i = 0; i < MAX_PINS + 3; i += 1) {
      state = apply(state, ALICE, MEMBER, `t${i}`, { kind: 'text', text: `${i}` });
      state = apply(state, ALICE, OWNER, `pin${i}`, { kind: 'pin', target: `t${i}`, pinned: true });
    }
    expect(state.group.pins).toHaveLength(MAX_PINS);
    expect(state.group.pins[0]).toBe(`t${MAX_PINS + 2}`);
  });

  it('lets admins remove others’ messages, but never the owner’s', () => {
    seq = 0;
    let state = apply(emptyTimeline, BOB, MEMBER, 'b', { kind: 'text', text: 'spam' });
    state = apply(state, ALICE, OWNER, 'o', { kind: 'text', text: 'rules' });
    state = apply(state, GHOST, MEMBER, 'x1', { kind: 'delete', target: 'b' });
    expect(state.byId['b']?.deleted).toBe(false);
    state = apply(state, GHOST, ADMIN, 'x2', { kind: 'delete', target: 'o' });
    expect(state.byId['o']?.deleted).toBe(false);
    // Moderation has no time window.
    state = apply(state, GHOST, ADMIN, 'x3', { kind: 'delete', target: 'b' }, T0 + 10 ** 10);
    expect(state.byId['b']?.deleted).toBe(true);
  });

  it('counts one vote per member, latest wins, and enforces single choice', () => {
    seq = 0;
    let state = apply(emptyTimeline, ALICE, OWNER, 'poll', {
      kind: 'poll',
      question: 'Lunch?',
      options: ['Pizza', 'Salad', 'Soup'],
      multiple: false,
    });
    state = apply(state, BOB, MEMBER, 'v1', { kind: 'vote', target: 'poll', choices: [0] });
    state = apply(state, BOB, MEMBER, 'v2', { kind: 'vote', target: 'poll', choices: [2] });
    state = apply(state, GHOST, MEMBER, 'v3', { kind: 'vote', target: 'poll', choices: [0, 1] });
    expect(state.byId['poll']?.poll?.votes).toEqual({ [BOB]: [2] });
    state = apply(state, BOB, MEMBER, 'v4', { kind: 'vote', target: 'poll', choices: [] });
    expect(state.byId['poll']?.poll?.votes).toEqual({});
    expect(state.byId['poll']?.text).toBe('Lunch?');
  });

  it('keeps mentions on text messages', () => {
    seq = 0;
    const state = apply(emptyTimeline, ALICE, MEMBER, 'm', {
      kind: 'text',
      text: 'hi @bob',
      mentions: [BOB, BOB],
    });
    expect(state.byId['m']?.mentions).toEqual([BOB]);
  });
});

describe('membership intents', () => {
  const record = (
    seqNo: number,
    authority: SenderAuthority | undefined,
    body: MessageBody,
    serverTime = T0,
  ): HistoryRecord => ({
    seq: seqNo,
    senderUserId: ALICE,
    senderDeviceId: 'd',
    serverTime: new Date(serverTime).toISOString(),
    clientMessageId: `c${seqNo}`,
    content: JSON.stringify({ v: 1, id: `c${seqNo}`, sentAt: serverTime, body }),
    ...(authority === undefined ? {} : { authority }),
  });

  it('confirms people only from senders allowed to add, recently, unless removed later', () => {
    const records = [
      record(1, ADMIN, { kind: 'group_members', add: [BOB, GHOST], remove: [] }),
      record(2, MEMBER, { kind: 'group_members', add: [ALICE], remove: [] }),
      record(3, OWNER, { kind: 'group_members', add: [], remove: [GHOST] }),
      record(4, undefined, { kind: 'group_members', add: [ALICE], remove: [] }),
    ];
    expect([...intendedMembers(records, T0 + 1000)]).toEqual([BOB]);
    expect(intendedMembers(records, T0 + INTENT_TTL_MS + 1).size).toBe(0);
    expect([
      ...intendedMembers(
        [record(5, OPEN_MEMBER, { kind: 'group_members', add: [GHOST], remove: [] })],
        T0,
      ),
    ]).toEqual([GHOST]);
  });

  it('ignores records whose content id does not match the transport id', () => {
    const forged = {
      ...record(1, ADMIN, { kind: 'group_members', add: [GHOST], remove: [] }),
      clientMessageId: 'other',
    };
    expect(intendedMembers([forged], T0).size).toBe(0);
  });
});
