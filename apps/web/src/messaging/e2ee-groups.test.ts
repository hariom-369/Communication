import type { Conversation } from '@tessera/validation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupPolicy, HistoryRecord, Identity } from '../crypto/protocol.js';

import { E2eeSession, type CryptoConnection } from './e2ee.js';

/**
 * Group orchestration (docs/groups.md §4): who creates the group, who gets added, who gets
 * removed. The worker and API are doubles; the Rust core re-checks every commit (group_tests.rs).
 */

const ME = '0192f0c1-0000-7000-8000-00000000000a';
const BOB = '0192f0c1-0000-7000-8000-00000000000b';
const CAROL = '0192f0c1-0000-7000-8000-00000000000c';
const GHOST = '0192f0c1-0000-7000-8000-00000000000d';
const GROUP = '0192f0c1-0000-7000-8000-0000000000f1';
const DEVICE = '0192f0c1-0000-7000-8000-0000000000d1';
const device = (user: string) => `${user.slice(0, -2)}d9`;

const identity: Identity = {
  userId: ME,
  deviceId: DEVICE,
  askPublicKey: 'ASK',
  askVersion: 1,
  certificate: 'CERT',
  trusted: true,
  pending: false,
  backups: false,
};

const policy = (overrides: Partial<GroupPolicy> = {}): GroupPolicy => ({
  v: 1,
  owner: ME,
  admins: [],
  membersCanAdd: false,
  membersCanEditInfo: true,
  announcementsOnly: false,
  ...overrides,
});

function meta(members: [string, 'owner' | 'admin' | 'member'][], epoch = 1): Conversation {
  return {
    id: GROUP,
    kind: 'group',
    ciphersuite: 1,
    epoch,
    lastSeq: 0,
    lastActivityAt: new Date(0).toISOString(),
    disappearingSeconds: 0,
    members: members.map(([userId, role]) => ({ userId, username: userId.slice(-1), role })),
    ackedSeq: 0,
    peersAckedSeq: 0,
    settings: { membersCanAdd: false, announcementsOnly: false },
  };
}

const intent = (seq: number, add: string[], remove: string[] = []): HistoryRecord => ({
  seq,
  senderUserId: ME,
  senderDeviceId: DEVICE,
  serverTime: new Date().toISOString(),
  clientMessageId: `i${seq}`,
  content: JSON.stringify({
    v: 1,
    id: `i${seq}`,
    sentAt: 1,
    body: { kind: 'group_members', add, remove },
  }),
  authority: { role: 'owner', editInfo: true, add: true },
});

const commit = { commit: 'C', welcome: null, welcomeTargets: [], epoch: 1 };

function setup(options: {
  exists: boolean;
  inGroup: string[];
  policy: GroupPolicy | null;
  history?: HistoryRecord[];
  serverEpoch?: number;
}) {
  const crypto = {
    init: vi.fn().mockResolvedValue({ identity }),
    keyPackages: vi.fn().mockResolvedValue([]),
    observeIdentity: vi.fn().mockResolvedValue('unchanged'),
    pin: vi.fn().mockResolvedValue({ key: 'k', version: 1, verified: false, changed: false }),
    observeDevices: vi.fn().mockResolvedValue([]),
    group: vi.fn(() =>
      Promise.resolve({
        exists: options.exists,
        epoch: 1,
        members: options.inGroup.map((userId) => ({
          userId,
          deviceId: userId === ME ? DEVICE : device(userId),
        })),
      }),
    ),
    groupPolicy: vi.fn(() => Promise.resolve(options.policy)),
    history: vi.fn(() => Promise.resolve(options.history ?? [])),
    createGroup: vi.fn().mockResolvedValue({ ...commit, commit: '', epoch: 0 }),
    selfUpdate: vi.fn().mockResolvedValue({ ...commit, epoch: 0 }),
    updateMembers: vi.fn().mockResolvedValue(commit),
    updatePolicy: vi.fn().mockResolvedValue(commit),
    mergePending: vi.fn().mockResolvedValue(2),
    clearPending: vi.fn().mockResolvedValue(undefined),
    needsUpdate: vi.fn().mockResolvedValue(false),
    abandonUnconfirmed: vi.fn().mockResolvedValue(true),
    discardGroup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  const keysOf = (userId: string) => ({
    userId,
    askPublicKey: 'A',
    askVersion: 1,
    devices: [{ deviceId: userId === ME ? DEVICE : device(userId) }],
  });
  const api = {
    ownKeys: vi
      .fn()
      .mockResolvedValue({ askVersion: 1, askPublicKey: 'ASK', devices: [{ deviceId: DEVICE }] }),
    keyPackageCount: vi.fn().mockResolvedValue({ oneTime: 100, lastResort: true }),
    userKeys: vi.fn((userId: string) => Promise.resolve(keysOf(userId))),
    claimKeyPackages: vi.fn((userId: string) =>
      Promise.resolve({
        keyPackages: [
          { deviceId: userId === ME ? DEVICE : device(userId), keyPackage: `KP-${userId}` },
        ],
      }),
    ),
    welcomes: vi.fn().mockResolvedValue({ welcomes: [] }),
    conversation: vi.fn(() => Promise.resolve({ epoch: options.serverEpoch ?? 1 })),
    commit: vi.fn().mockResolvedValue({ epoch: 2, seq: 1 }),
  };
  const session = new E2eeSession(
    () => crypto as unknown as CryptoConnection,
    api as never,
    ME,
    vi.fn(),
  );
  return { crypto, api, session };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('creating a group', () => {
  it('is done by the owner, with the policy and only the owner’s devices', async () => {
    const { crypto, api, session } = setup({
      exists: false,
      inGroup: [],
      policy: null,
      serverEpoch: 0,
    });
    await session.start();
    await session.prepare(
      meta(
        [
          [ME, 'owner'],
          [BOB, 'member'],
          [GHOST, 'member'],
        ],
        0,
      ),
    );
    expect(crypto.createGroup).toHaveBeenCalledWith(
      GROUP,
      [],
      [BOB, GHOST, ME],
      expect.objectContaining({ owner: ME, admins: [], membersCanAdd: false }),
    );
    // Alone in the group: a self-update claims the first epoch.
    expect(crypto.selfUpdate).toHaveBeenCalled();
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.claimKeyPackages).not.toHaveBeenCalledWith(BOB);
    session.stop();
  });

  it('is never done by a member: they wait for a Welcome', async () => {
    const { crypto, session } = setup({ exists: false, inGroup: [], policy: null, serverEpoch: 0 });
    await session.start();
    await session.prepare(
      meta(
        [
          [BOB, 'owner'],
          [ME, 'member'],
        ],
        0,
      ),
    );
    expect(crypto.createGroup).not.toHaveBeenCalled();
    expect(session.security(GROUP).waitingForWelcome).toBe(true);
    session.stop();
  });
});

describe('membership', () => {
  it('adds only people confirmed by a membership intent — never one the server made up', async () => {
    const { crypto, session } = setup({
      exists: true,
      inGroup: [ME],
      policy: policy(),
      history: [intent(1, [BOB])],
    });
    await session.start();
    await session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
        [GHOST, 'member'],
      ]),
    );
    expect(crypto.updateMembers).toHaveBeenCalledWith(GROUP, [`KP-${BOB}`], [], [BOB, GHOST]);
    expect(session.security(GROUP).unconfirmed).toEqual([GHOST]);
    session.stop();
  });

  it('does not add anyone when this user may not add people', async () => {
    const { crypto, session } = setup({
      exists: true,
      inGroup: [ME, BOB],
      policy: policy({ owner: BOB }),
      history: [intent(1, [CAROL])],
    });
    await session.start();
    await session.prepare(
      meta([
        [BOB, 'owner'],
        [ME, 'member'],
        [CAROL, 'member'],
      ]),
    );
    expect(crypto.updateMembers).not.toHaveBeenCalled();
    expect(session.security(GROUP).awaitingAdd).toEqual([CAROL]);
    session.stop();
  });

  it('honours a later removal intent', async () => {
    const { crypto, session } = setup({
      exists: true,
      inGroup: [ME],
      policy: policy(),
      history: [intent(1, [BOB]), intent(2, [], [BOB])],
    });
    await session.start();
    await session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
      ]),
    );
    expect(crypto.updateMembers).not.toHaveBeenCalled();
    session.stop();
  });

  it('removes every device of someone the server no longer lists', async () => {
    const { crypto, session } = setup({
      exists: true,
      inGroup: [ME, BOB, CAROL],
      policy: policy(),
    });
    await session.start();
    await session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
      ]),
    );
    expect(crypto.updateMembers).toHaveBeenCalledWith(GROUP, [], [[CAROL, device(CAROL)]], [BOB]);
    session.stop();
  });

  it('tells listeners who it added (to share the group name with them)', async () => {
    const { session } = setup({
      exists: true,
      inGroup: [ME],
      policy: policy(),
      history: [intent(1, [BOB])],
    });
    const added = vi.fn();
    session.onMembersAdded(added);
    await session.start();
    await session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
      ]),
    );
    expect(added).toHaveBeenCalledWith(GROUP, [BOB]);
    session.stop();
  });
});

describe('lost races', () => {
  it('retries a commit that another commit beat to the epoch', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { crypto, api, session } = setup({
      exists: true,
      inGroup: [ME],
      policy: policy(),
      history: [intent(1, [BOB])],
    });
    await session.start();
    const { ApiError } = await import('../api/client.js');
    api.commit.mockRejectedValueOnce(
      new ApiError({ type: 'about:blank', title: 'x', status: 409, code: 'CONFLICT' } as never),
    );
    await session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
      ]),
    );
    expect(crypto.updateMembers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(crypto.updateMembers).toHaveBeenCalledTimes(2);
    expect(api.commit).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it('runs again when the member list changes during a run', async () => {
    const { crypto, session } = setup({
      exists: true,
      inGroup: [ME],
      policy: policy(),
      history: [intent(1, [BOB, CAROL])],
    });
    await session.start();
    const first = session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
      ]),
    );
    const second = session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
        [CAROL, 'member'],
      ]),
    );
    await Promise.all([first, second]);
    expect(crypto.updateMembers).toHaveBeenCalledTimes(2);
    expect(crypto.updateMembers.mock.calls[1]?.[3]).toEqual([BOB, CAROL]);
    session.stop();
  });
});

describe('owner takeover', () => {
  it('an admin the server made owner takes over once the old owner is gone', async () => {
    const { crypto, session } = setup({
      exists: true,
      inGroup: [ME, BOB],
      policy: policy({ owner: CAROL, admins: [ME] }),
    });
    await session.start();
    await session.prepare(
      meta([
        [ME, 'owner'],
        [BOB, 'member'],
      ]),
    );
    expect(crypto.updatePolicy).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ owner: ME, admins: [] }),
      [BOB],
    );
    session.stop();
  });

  it('never while the owner is still listed, or for a non-admin', async () => {
    const listed = setup({
      exists: true,
      inGroup: [ME, CAROL],
      policy: policy({ owner: CAROL, admins: [ME] }),
    });
    await listed.session.start();
    await listed.session.prepare(
      meta([
        [ME, 'owner'],
        [CAROL, 'member'],
      ]),
    );
    expect(listed.crypto.updatePolicy).not.toHaveBeenCalled();
    listed.session.stop();
    const member = setup({ exists: true, inGroup: [ME], policy: policy({ owner: CAROL }) });
    await member.session.start();
    await member.session.prepare(meta([[ME, 'owner']]));
    expect(member.crypto.updatePolicy).not.toHaveBeenCalled();
    member.session.stop();
  });
});

describe('policy changes', () => {
  it('commits the new policy and reports a lost race', async () => {
    const { crypto, api, session } = setup({ exists: true, inGroup: [ME, BOB], policy: policy() });
    await session.start();
    const group = meta([
      [ME, 'owner'],
      [BOB, 'member'],
    ]);
    expect(await session.updatePolicy(group, (p) => ({ ...p, admins: [BOB] }))).toBe(true);
    expect(crypto.updatePolicy).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ admins: [BOB] }),
      [BOB, ME],
    );
    api.commit.mockRejectedValueOnce(
      Object.assign(
        new (await import('../api/client.js')).ApiError({
          type: 'about:blank',
          title: 'x',
          status: 409,
          code: 'CONFLICT',
        } as never),
      ),
    );
    expect(await session.updatePolicy(group, (p) => p)).toBe(false);
    expect(crypto.clearPending).toHaveBeenCalled();
    session.stop();
  });
});
