import type { AddressInfo } from 'node:net';

import { createLogger } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import { channelPostSchema } from '@tessera/validation';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildFetcherApp } from '../../fetcher-app.js';
import { SafeFetchError } from '../../platform/safe-fetch/index.js';
import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * Link previews through the isolated fetcher (security review F-05), as production runs them:
 * the API holds no route to user-supplied URLs and asks the fetcher service over HTTP.
 */

const TOKEN = 'integration-fetcher-token-'.padEnd(48, 'x');
let fetcher: FastifyInstance;
let env: IntegrationApp;
const asked: string[] = [];

beforeAll(async () => {
  fetcher = await buildFetcherApp({
    logger: createLogger({
      service: 'link-fetcher',
      level: 'fatal',
      errorDetails: false,
      destination: new MemoryDestination(),
    }),
    token: TOKEN,
    maxConcurrent: 4,
    // Stands in for the network: one page exists, everything else is refused as private.
    fetchPreview: (url) => {
      asked.push(url);
      if (url === 'https://news.example/today')
        return Promise.resolve({
          url,
          title: 'Today',
          description: 'What happened',
          siteName: 'News',
        });
      return Promise.reject(new SafeFetchError('blocked_address'));
    },
  });
  await fetcher.listen({ host: '127.0.0.1', port: 0 });
  const port = (fetcher.server.address() as AddressInfo).port;
  env = await startIntegrationApp({
    linkPreviewFetcher: { url: `http://127.0.0.1:${String(port)}`, token: TOKEN },
  });
});
afterAll(async () => {
  await env.close();
  await fetcher.close();
});

describe('link previews via the isolated fetcher', () => {
  it('are fetched by the fetcher service, cached, and attached to posts', async () => {
    const owner = await createActiveUser(env);
    const preview = await owner.client.post('/api/v1/link-previews', {
      url: 'https://news.example/today',
    });
    expect(preview.json()).toEqual({
      url: 'https://news.example/today',
      title: 'Today',
      description: 'What happened',
      siteName: 'News',
    });
    expect(
      (await owner.client.post('/api/v1/link-previews', { url: 'https://10.0.0.1/admin' })).json(),
    ).toBeNull();

    const created = await owner.client.post('/api/v1/channels', {
      handle: `fetcher_${Date.now().toString(36)}`,
      title: 'News',
      description: 'Links',
      visibility: 'public',
      commentsEnabled: false,
      slowModeSeconds: 0,
    });
    const channelId = created.json<{ id: string }>().id;
    const post = await owner.client.post(`/api/v1/channels/${channelId}/posts`, {
      body: 'Read this',
      previewUrl: 'https://news.example/today',
      poll: null,
      publish: 'now',
    });
    expect(channelPostSchema.parse(post.json()).preview?.title).toBe('Today');
    // The second use of the link came from the cache: the fetcher was asked once per URL.
    expect(asked.filter((url) => url === 'https://news.example/today')).toHaveLength(1);
  });
});
