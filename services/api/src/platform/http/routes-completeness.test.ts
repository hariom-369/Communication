import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { routeCatalog } from '../../route-catalog.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function testSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'));
  return Promise.all(
    files.map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
  );
}

/**
 * Structural enforcement from docs/testing.md §4: every production route declares its full
 * contract and is referenced by at least one test (by route id).
 */
describe('route completeness', () => {
  const catalog = routeCatalog();
  const routes = catalog.routes;
  afterAll(() => catalog.close());

  it('has unique ids and method+url pairs', () => {
    expect(new Set(routes.map((route) => route.id)).size).toBe(routes.length);
    expect(new Set(routes.map((route) => `${route.method} ${route.url}`)).size).toBe(routes.length);
  });

  it.each(routes.map((route) => [route.id, route] as const))(
    '%s declares its contract',
    (_id, route) => {
      expect(route.id).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(route.summary.length).toBeGreaterThan(0);
      expect(route.authorize.name.length).toBeGreaterThan(0);
      expect(route.rateLimit.limit).toBeGreaterThan(0);
      expect(route.rateLimit.burst).toBeGreaterThan(0);
      if (route.audit.kind === 'none') expect(route.audit.reason.length).toBeGreaterThan(0);
      else expect(route.audit.actions.length).toBeGreaterThan(0);
      if (route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH') {
        // Webhooks take the raw body: their handler verifies the signature, then parses it.
        if (route.auth.kind === 'webhook') expect(route.schema.body).toBeUndefined();
        else expect(route.schema.body).toBeDefined();
      }
    },
  );

  it('references every route id from at least one test file', async () => {
    const sources = (await testSources(path.join(SRC, 'modules'))).join('\n');
    const untested = routes
      .filter((route) => !sources.includes(`'${route.id}'`))
      .map((route) => route.id);
    expect(untested).toEqual([]);
  });
});
