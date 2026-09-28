import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TABLE_OWNERS } from './db/schema.js';

const MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'modules');
const IMPORT = /\bfrom\s+'([^']+)'/g;

/**
 * Module boundaries (ADR-001): code in modules/<a> may import another module only through
 * modules/<b>/index.js, never its internals.
 */
describe('module boundaries', () => {
  it('modules import each other only through their public index', async () => {
    const modules = (await readdir(MODULES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const violations: string[] = [];

    for (const name of modules) {
      const files = await readdir(path.join(MODULES, name), {
        recursive: true,
        withFileTypes: true,
      });
      for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))) {
        const fullPath = path.join(file.parentPath, file.name);
        const source = await readFile(fullPath, 'utf8');
        for (const [, specifier] of source.matchAll(IMPORT)) {
          if (!specifier?.startsWith('.')) continue;
          const target = path.resolve(path.dirname(fullPath), specifier);
          const relative = path.relative(MODULES, target);
          if (relative.startsWith('..')) continue; // platform/test code outside modules
          const [targetModule, ...rest] = relative.split(path.sep);
          if (targetModule !== name && rest.join('/') !== 'index.js') {
            violations.push(`${path.relative(MODULES, fullPath)} -> ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

const TABLE_ACCESS =
  /\b(?:selectFrom|insertInto|updateTable|deleteFrom|innerJoin|leftJoin)\(\s*'([a-z_]+)'/g;

/**
 * Data ownership (ADR-001, docs/architecture.md §4): production code in modules/<m> may only
 * query tables owned by <m>. Other modules' data is reached through their public interfaces.
 */
describe('table ownership', () => {
  it('modules only query their own tables', async () => {
    const modules = (await readdir(MODULES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const violations: string[] = [];
    for (const name of modules) {
      const files = await readdir(path.join(MODULES, name), {
        recursive: true,
        withFileTypes: true,
      });
      for (const file of files.filter(
        (e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'),
      )) {
        const source = await readFile(path.join(file.parentPath, file.name), 'utf8');
        for (const [, table] of source.matchAll(TABLE_ACCESS)) {
          const owner = TABLE_OWNERS[table as keyof typeof TABLE_OWNERS] as string | undefined;
          if (owner !== name)
            violations.push(
              `${name}/${file.name} -> ${String(table)} (owner: ${owner ?? 'unknown'})`,
            );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
