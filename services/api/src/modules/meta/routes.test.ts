import { versionResponseSchema } from '@tessera/validation';
import { afterEach, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from '../../test/helpers.js';

import { CURRENT_PROTOCOL, MINIMUM_SUPPORTED_PROTOCOL } from './index.js';

const ROUTE_ID = 'meta.version';

let current: TestApp | undefined;
afterEach(async () => {
  await current?.app.close();
});

describe(ROUTE_ID, () => {
  it('returns build and protocol versions without authentication', async () => {
    current = await buildTestApp();
    const response = await current.app.inject({ url: '/api/v1/meta/version' });
    expect(response.statusCode).toBe(200);
    expect(versionResponseSchema.parse(response.json())).toEqual({
      api: 'v1',
      build: { version: '1.2.3', commit: 'abc123' },
      protocol: { current: CURRENT_PROTOCOL, minimumSupported: MINIMUM_SUPPORTED_PROTOCOL },
    });
  });

  it('keeps the minimum supported protocol at or below the current one', () => {
    expect(MINIMUM_SUPPORTED_PROTOCOL).toBeLessThanOrEqual(CURRENT_PROTOCOL);
  });

  it('is rate limited per client', async () => {
    current = await buildTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await current.app.inject({ url: '/api/v1/meta/version' })).statusCode);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(20); // burst
    expect(statuses.at(-1)).toBe(429);
  });
});
