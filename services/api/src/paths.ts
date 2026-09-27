import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the SQL migrations shipped with this build (works from src/ and dist/). */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
