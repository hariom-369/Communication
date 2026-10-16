import type { AddressInfo } from 'node:net';

import { createLogger, createMetricsRegistry } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFetcherApp } from './fetcher-app.js';
import { loadFetcherConfig } from './fetcher-config.js';
import { LinkPreviewer } from './modules/channels/previews.js';
import { SafeFetchError, type LinkPreview } from './platform/safe-fetch/index.js';
import {
  FETCHER_PREVIEW_PATH,
  FetcherUnavailableError,
  remoteLinkPreviewFetcher,
} from './platform/safe-fetch/remote.js';

const TOKEN = 'k'.repeat(43);
const logger = createLogger({
  service: 'test',
  level: 'fatal',
  errorDetails: false,
  destination: new MemoryDestination(),
});
const sample: LinkPreview = {
  url: 'https://example.com/a',
  title: 'A page',
  description: null,
  siteName: 'Example',
};

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listening(fetchPreview: (url: string) => Promise<LinkPreview>, maxConcurrent = 4) {
  const app = await buildFetcherApp({
    logger,
    token: TOKEN,
    maxConcurrent,
    fetchPreview,
    metrics: createMetricsRegistry('link-fetcher'),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  closers.push(() => app.close());
  return { app, baseUrl: `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}` };
}

const ask = (token: string | null, body: unknown = { url: 'https://example.com/a' }) => ({
  method: 'POST' as const,
  url: FETCHER_PREVIEW_PATH,
  headers: {
    'content-type': 'application/json',
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  },
  payload: JSON.stringify(body),
});

describe('isolated link-preview fetcher (F-05)', () => {
  it('answers only the API (bearer token), and nothing but its one route', async () => {
    const fetchPreview = vi.fn(() => Promise.resolve(sample));
    const { app } = await listening(fetchPreview);
    expect((await app.inject(ask(null))).statusCode).toBe(401);
    expect((await app.inject(ask('k'.repeat(42) + 'x'))).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(404);
    expect(fetchPreview).not.toHaveBeenCalled();
    const ok = await app.inject(ask(TOKEN));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ preview: sample });
  });

  it('reports refusals with their reason, and refuses malformed requests', async () => {
    const { app } = await listening(() => Promise.reject(new SafeFetchError('blocked_address')));
    expect((await app.inject(ask(TOKEN))).json()).toEqual({
      preview: null,
      reason: 'blocked_address',
    });
    expect((await app.inject(ask(TOKEN, { url: 'x', extra: 1 }))).statusCode).toBe(400);
    expect((await app.inject(ask(TOKEN, { url: 'x'.repeat(5000) }))).statusCode).toBe(413);
  });

  it('sheds load beyond its concurrency limit instead of queueing it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app } = await listening(async () => {
      await gate;
      return sample;
    }, 1);
    const first = app.inject(ask(TOKEN));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await app.inject(ask(TOKEN));
    expect(second.statusCode).toBe(503);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('is used by the API through the remote client', async () => {
    const { baseUrl } = await listening(() => Promise.resolve(sample));
    const remote = remoteLinkPreviewFetcher({ baseUrl, token: TOKEN });
    expect(await remote('https://example.com/a')).toEqual(sample);
    // Refused locally before asking (same URL rules as the fetcher).
    await expect(remote('http://example.com/')).rejects.toBeInstanceOf(SafeFetchError);
    const wrongToken = remoteLinkPreviewFetcher({ baseUrl, token: 'z'.repeat(43) });
    await expect(wrongToken('https://example.com/a')).rejects.toBeInstanceOf(
      FetcherUnavailableError,
    );
    const down = remoteLinkPreviewFetcher({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
    await expect(down('https://example.com/a')).rejects.toBeInstanceOf(FetcherUnavailableError);
  });

  it('treats the fetcher’s answer as untrusted (a compromised fetcher cannot inject content)', async () => {
    const answers: unknown[] = [
      { preview: { ...sample, url: 'javascript:alert(1)' } },
      { preview: { ...sample, title: 'x'.repeat(201) } },
      { preview: { ...sample, title: 'bidi ‮ override' } },
      { preview: { ...sample, image: 'https://tracker.example/p.gif' } },
      { preview: null, reason: 'something else' },
    ];
    const fake = Fastify();
    let next = 0;
    fake.post(FETCHER_PREVIEW_PATH, () => answers[next++]);
    await fake.listen({ host: '127.0.0.1', port: 0 });
    closers.push(() => fake.close());
    const remote = remoteLinkPreviewFetcher({
      baseUrl: `http://127.0.0.1:${String((fake.server.address() as AddressInfo).port)}`,
      token: TOKEN,
    });
    await expect(remote('https://example.com/a')).rejects.toBeInstanceOf(SafeFetchError);
    for (let i = 1; i < answers.length; i += 1)
      await expect(remote('https://example.com/a')).rejects.toBeInstanceOf(FetcherUnavailableError);
  });

  it('does not cache a fetcher outage as a missing preview', async () => {
    const valkey = new Redis({ lazyConnect: true, enableOfflineQueue: false });
    const fetch = vi
      .fn<(url: string) => Promise<LinkPreview>>()
      .mockRejectedValueOnce(new FetcherUnavailableError('network'))
      .mockResolvedValue(sample);
    const results: string[] = [];
    // Valkey is unreachable here, so every lookup misses and every write is dropped: the
    // previewer must still answer, and an outage must surface as `unavailable`.
    const previewer = new LinkPreviewer(valkey, 'test', fetch, {
      onResult: (result) => results.push(result),
    });
    expect(await previewer.preview('https://example.com/a')).toBeNull();
    expect(await previewer.preview('https://example.com/a')).toEqual(sample);
    expect(results).toEqual(['unavailable', 'fetched']);
    valkey.disconnect();
  });
});

describe('fetcher config', () => {
  it('needs only its token, and refuses a short one', () => {
    expect(loadFetcherConfig({ FETCHER_TOKEN: TOKEN }).FETCHER_MAX_CONCURRENT).toBe(32);
    expect(() => loadFetcherConfig({ FETCHER_TOKEN: 'short' })).toThrow();
    expect(() => loadFetcherConfig({})).toThrow();
  });
});
