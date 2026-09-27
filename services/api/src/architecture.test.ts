import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
