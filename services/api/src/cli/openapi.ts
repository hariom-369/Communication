import { writeFile } from 'node:fs/promises';

import { createLogger } from '@tessera/platform';

import { buildApp } from '../app.js';
import { InProcessRateLimiter } from '../platform/rate-limit.js';
import { routeCatalog } from '../route-catalog.js';

/**
 * Writes the OpenAPI document generated from the route definitions. CI regenerates it and fails
 * if the committed file differs, so API contract changes are always visible in review.
 */
const output = process.argv[2];
if (output === undefined) throw new Error('Usage: openapi <output-file>');

const catalog = routeCatalog();
const app = await buildApp({
  logger: createLogger({ service: 'api-openapi', level: 'error', errorDetails: true }),
  rateLimiter: new InProcessRateLimiter(),
  allowedOrigins: ['https://app.invalid'],
  trustProxyHops: 0,
  bodyLimitBytes: 64 * 1024,
  hsts: false,
  routes: catalog.routes,
  sessions: { authenticate: () => Promise.resolve(null) },
});
const document = app.swagger();
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
await catalog.close();
