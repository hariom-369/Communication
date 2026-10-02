import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client.js';
import type { MediaDigest } from '../crypto/protocol.js';

import { HttpError, MediaExpiredError, MediaTransfer, type Http } from './media-transfer.js';

/** Upload/download orchestration; the crypto worker and storage are test doubles. */

const PART = 8;
const digest: MediaDigest = {
  key: 'K',
  plaintextSha256: 'P',
  ciphertextSha256: 'C',
  plaintextSize: 10,
  ciphertextSize: 20,
};

function setup() {
  const crypto = {
    encryptMedia: vi.fn(() =>
      Promise.resolve({ ciphertext: new Blob([new Uint8Array(20)]), digest }),
    ),
    decryptMedia: vi.fn((_c: Blob, _d: MediaDigest, type: string) =>
      Promise.resolve(new Blob(['plain'], { type })),
    ),
    cachedMedia: vi.fn((): Promise<Blob | null> => Promise.resolve(null)),
    cacheMedia: vi.fn(() => Promise.resolve()),
  };
  const api = {
    createUpload: vi.fn(() =>
      Promise.resolve({
        blobId: 'B',
        partSize: PART,
        parts: [1, 2, 3].map((partNumber) => ({ partNumber, url: `u${partNumber}` })),
        urlsExpireAt: new Date().toISOString(),
      }),
    ),
    uploadParts: vi.fn((_id: string, numbers: number[]) =>
      Promise.resolve({
        parts: numbers.map((partNumber) => ({ partNumber, url: `fresh${partNumber}` })),
        urlsExpireAt: new Date().toISOString(),
      }),
    ),
    completeUpload: vi.fn(() => Promise.resolve({ blobId: 'B' })),
    abortUpload: vi.fn(() => Promise.resolve({ ok: true as const })),
    mediaDownload: vi.fn(() =>
      Promise.resolve({ url: 'download', size: 20, urlExpiresAt: new Date().toISOString() }),
    ),
  };
  const puts: { url: string; size: number }[] = [];
  const http = {
    put: vi.fn((url: string, body: Blob, onProgress: (n: number) => void) => {
      puts.push({ url, size: body.size });
      onProgress(body.size);
      return Promise.resolve(`etag-${url}`);
    }),
    get: vi.fn(() => Promise.resolve(new Blob([new Uint8Array(20)]))),
  } satisfies Http;
  const transfer = new MediaTransfer(api, crypto, http);
  return { crypto, api, http, puts, transfer };
}

describe('MediaTransfer.upload', () => {
  it('encrypts, uploads each part to its URL, completes and returns the reference', async () => {
    const { api, puts, transfer, crypto } = setup();
    const progress: number[] = [];
    const reference = await transfer.upload(
      new Blob(['x']),
      (f) => progress.push(f),
      new AbortController().signal,
    );
    expect(api.createUpload).toHaveBeenCalledWith(20);
    expect(puts).toEqual([
      { url: 'u1', size: 8 },
      { url: 'u2', size: 8 },
      { url: 'u3', size: 4 },
    ]);
    expect(api.completeUpload).toHaveBeenCalledWith('B', [
      { partNumber: 1, etag: 'etag-u1' },
      { partNumber: 2, etag: 'etag-u2' },
      { partNumber: 3, etag: 'etag-u3' },
    ]);
    expect(reference).toEqual({ blobId: 'B', ...digest });
    expect(progress.at(-1)).toBe(1);
    // The sender keeps its own ciphertext so it never downloads its own upload.
    expect(crypto.cacheMedia).toHaveBeenCalledWith('B', expect.any(Blob));
  });

  it('gets a fresh URL when one is rejected, and gives up (aborting the upload) eventually', async () => {
    vi.useFakeTimers();
    const { api, http, transfer } = setup();
    http.put.mockRejectedValueOnce(new HttpError(403));
    const done = transfer.upload(new Blob(['x']), () => undefined, new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(api.uploadParts).toHaveBeenCalledWith('B', [1]);
    expect(http.put.mock.calls.map((call) => call[0])).toContain('fresh1');

    http.put.mockRejectedValue(new HttpError(500));
    const failing = transfer.upload(new Blob(['x']), () => undefined, new AbortController().signal);
    const outcome = failing.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(HttpError);
    expect(api.abortUpload).toHaveBeenCalledWith('B');
    expect(api.completeUpload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('MediaTransfer.open', () => {
  it('downloads, verifies in the worker, caches the verified ciphertext and reuses it', async () => {
    const { crypto, http, transfer } = setup();
    const reference = { blobId: 'B', ...digest };
    const blob = await transfer.open(reference, 'image/png');
    expect(blob.type).toBe('image/png');
    expect(crypto.decryptMedia).toHaveBeenCalledWith(expect.any(Blob), digest, 'image/png');
    expect(crypto.cacheMedia).toHaveBeenCalledWith('B', expect.any(Blob));
    expect(http.get).toHaveBeenCalledTimes(1);

    crypto.cachedMedia.mockResolvedValue(new Blob([new Uint8Array(20)]));
    await new MediaTransfer({} as never, crypto, http).open(reference, 'image/png');
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('does not cache ciphertext that fails verification, and reports expiry', async () => {
    const { api, crypto, transfer } = setup();
    crypto.decryptMedia.mockRejectedValueOnce(new Error('UNTRUSTED'));
    await expect(transfer.open({ blobId: 'X', ...digest }, 'x')).rejects.toThrow('UNTRUSTED');
    expect(crypto.cacheMedia).not.toHaveBeenCalled();

    api.mediaDownload.mockRejectedValueOnce(
      new ApiError({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' }),
    );
    await expect(transfer.open({ blobId: 'Y', ...digest }, 'x')).rejects.toBeInstanceOf(
      MediaExpiredError,
    );
  });
});
