import { AppError } from '@tessera/platform';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Header every state-changing request from our clients must carry (docs/authentication.md §5). */
export const CSRF_HEADER = 'x-tessera-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth for cookie-authenticated requests:
 *  1. a custom header that cross-site forms cannot send and cross-origin fetch cannot send
 *     without a CORS preflight (which our CORS policy only grants to allowed origins);
 *  2. an `Origin` allow-list whenever the browser sends one;
 *  3. rejection of requests that the browser labels `Sec-Fetch-Site: cross-site`.
 */
export function installCsrfProtection(
  app: FastifyInstance,
  options: { allowedOrigins: readonly string[] },
): void {
  const allowed = new Set(options.allowedOrigins);
  app.addHook('onRequest', (request, _reply, done) => {
    done(isAllowed(request, allowed) ? undefined : new AppError('CSRF_REJECTED'));
  });
}

function isAllowed(request: FastifyRequest, allowedOrigins: ReadonlySet<string>): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) return false;
  return request.headers[CSRF_HEADER] === '1';
}
