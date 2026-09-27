import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokensCss } from './css.js';

/** Build step: emits dist/tokens.css from the token source and copies component styles. */
const outDir = process.argv[2];
if (outDir === undefined) throw new Error('Usage: build-css <out-dir>');
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'tokens.css'), tokensCss());
await copyFile(path.join(srcDir, 'components.css'), path.join(outDir, 'components.css'));
