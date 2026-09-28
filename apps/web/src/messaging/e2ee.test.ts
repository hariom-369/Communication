import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client.js';
import type { Identity } from '../crypto/protocol.js';

import { E2eeSession, type CryptoConnection } from './e2ee.js';

/**
 * Orchestration rules of the E2EE session for linking and backups. The worker and the API are
 * test doubles; the cryptography itself is covered by crypto/engine.test.ts and the Rust tests.
 */

const ME = '0192f0c1-0000-7000-8000-00000000000a';
const DEVICE = '0192f0c1-0000-7000-8000-0000000000d1';

const identity = (overrides: Partial<Identity> = {}): Identity => ({
  userId: ME,
  deviceId: DEVICE,
  askPublicKey: 'ASK',
  askVersion: 1,
  certificate: 'CERT',
  trusted: true,
  pending: false,
  backups: true,
  ...overrides,
});

const problem = (status: number) =>
  new ApiError({ type: 'about:blank', title: 'x', status, code: 'CONFLICT' } as never);

function setup(local: Identity | null) {
  const crypto = {
    init: vi.fn().mockResolvedValue({ identity: local }),
    createPending: vi.fn().mockResolvedValue(identity({ pending: true, askPublicKey: null })),
    linkRequest: vi.fn().mockResolvedValue({ hpkePublic: 'H', signaturePublic: 'S' }),
    linkCode: vi.fn().mockResolvedValue('CODE-CODE'),
    completeLink: vi.fn().mockResolvedValue(identity({ backups: false })),
    keyPackages: vi.fn((count: number) =>
      Promise.resolve(Array.from({ length: count }, () => 'KP')),
    ),
    backupOwns: vi.fn().mockResolvedValue(true),
    backupExport: vi.fn((version: number) =>
      Promise.resolve({ blob: 'B', manifest: `{"version":${version}}`, mac: 'M' }),
    ),
    close: vi.fn(),
  };
  const api = {
    ownKeys: vi.fn().mockResolvedValue({ askVersion: 1, askPublicKey: 'ASK', devices: [] }),
    createLink: vi.fn().mockResolvedValue({
      linkId: 'L',
      shortId: 'AQIDBAU=',
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    }),
    linkStatus: vi.fn().mockResolvedValue({ status: 'pending', sealed: null }),
    addDevice: vi.fn().mockResolvedValue({}),
    backupStatus: vi.fn(),
    uploadBackup: vi.fn().mockResolvedValue({ version: 1 }),
    keyPackageCount: vi.fn().mockResolvedValue({ oneTime: 100, lastResort: true }),
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
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('linking this device', () => {
  it('shows a code, polls, then completes against the account’s current identity key', async () => {
    const { crypto, api, session } = setup(null);
    api.ownKeys.mockResolvedValue({ askVersion: 3, askPublicKey: 'ASK3', devices: [] });
    await session.start();
    expect(session.status).toBe('setup-required');

    const state = await session.startLink('Laptop');
    expect(state).toMatchObject({ phase: 'waiting', code: 'CODE-CODE' });
    expect(api.createLink).toHaveBeenCalledWith({
      deviceId: DEVICE,
      hpkePublic: 'H',
      signaturePublic: 'S',
      label: 'Laptop',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.linkStatus).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('setup-required');

    api.linkStatus.mockResolvedValue({ status: 'approved', sealed: 'SEALED' });
    await vi.advanceTimersByTimeAsync(2000);
    // The expected identity comes from the key directory, never from the sealed payload.
    expect(crypto.completeLink).toHaveBeenCalledWith('SEALED', 'AQIDBAU=', 'ASK3', 3);
    expect(api.addDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: DEVICE, label: 'Laptop', trusted: true }),
    );
    expect(session.status).toBe('ready');
    expect(session.link?.phase).toBe('done');
    session.stop();
  });

  it('stops at expiry and when the payload cannot be verified', async () => {
    const { crypto, api, session } = setup(null);
    await session.start();
    await session.startLink('Laptop');
    api.linkStatus.mockRejectedValue(problem(404));
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.link?.phase).toBe('expired');

    await session.startLink('Laptop');
    api.linkStatus.mockResolvedValue({ status: 'approved', sealed: 'SEALED' });
    crypto.completeLink.mockRejectedValue(new Error('UNTRUSTED: link payload'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.link?.phase).toBe('failed');
    expect(api.addDevice).not.toHaveBeenCalled();
    expect(session.status).toBe('setup-required');
    session.stop();
  });
});

describe('backups', () => {
  const status = (latest: number | null, wraps = 1) => ({
    latest:
      latest === null
        ? null
        : {
            version: latest,
            createdAt: new Date().toISOString(),
            size: 1,
            manifest: `{"version":${latest}}`,
            mac: 'M',
          },
    wraps: Array.from({ length: wraps }, (_, i) => ({ id: `w${i}` })),
  });

  it('uploads the next version, retrying when another device wins the race', async () => {
    const { crypto, api, session } = setup(identity());
    api.ownKeys.mockResolvedValue({
      askVersion: 1,
      askPublicKey: 'ASK',
      devices: [{ deviceId: DEVICE }],
    });
    api.backupStatus.mockResolvedValue(status(4));
    await session.start();
    api.uploadBackup.mockReset();
    crypto.backupExport.mockClear();
    api.backupStatus
      .mockResolvedValueOnce(status(4))
      .mockResolvedValueOnce(status(5))
      .mockResolvedValue(status(6));
    api.uploadBackup.mockRejectedValueOnce(problem(409)).mockResolvedValue({ version: 6 });
    expect(await session.backupNow()).toBe('uploaded');
    expect(crypto.backupExport.mock.calls.map((call) => call[0])).toEqual([5, 6]);
    session.stop();
  });

  it('does not overwrite backups made with another backup key, and does nothing when off', async () => {
    const { crypto, api, session } = setup(identity());
    api.ownKeys.mockResolvedValue({
      askVersion: 1,
      askPublicKey: 'ASK',
      devices: [{ deviceId: DEVICE }],
    });
    api.backupStatus.mockResolvedValue(status(2, 0));
    await session.start();
    expect(await session.backupNow()).toBe('off');
    api.backupStatus.mockResolvedValue(status(2));
    crypto.backupOwns.mockResolvedValue(false);
    expect(await session.backupNow()).toBe('not-owner');
    expect(api.uploadBackup).not.toHaveBeenCalled();
    session.stop();
  });
});
