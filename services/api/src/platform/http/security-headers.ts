import type { FastifyInstance } from 'fastify';

/**
 * Security headers for API responses (docs/security.md §3). The API serves JSON only, so the CSP
 * forbids everything; the web app's richer CSP is set by the static hosting layer.
 */
const HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cache-control': 'no-store',
};

export function installSecurityHeaders(app: FastifyInstance, options: { hsts: boolean }): void {
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(HEADERS)) void reply.header(name, value);
    if (options.hsts) {
      void reply.header(
        'strict-transport-security',
        'max-age=63072000; includeSubDomains; preload',
      );
    }
    void reply.header('x-request-id', request.id);
    return payload;
  });
}
