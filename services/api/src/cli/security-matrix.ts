import { writeFile } from 'node:fs/promises';

import { routeCatalog } from '../route-catalog.js';
import { renderMatrix } from '../security-matrix.js';

/** Writes the route security matrix (see security-matrix.ts). */
const output = process.argv[2];
if (output === undefined) throw new Error('Usage: security-matrix <output-file>');

const catalog = routeCatalog();
await writeFile(output, renderMatrix(catalog.routes, catalog.adminRoutes));
await catalog.close();
