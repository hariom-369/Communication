import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The admin console (docs/admin.md, ADR-050): a static bundle on its own origin, separate from
 * the user app. In production it is served behind the identity-aware proxy with the admin API
 * under the same origin (`/admin/v1/*`). Locally, Vite proxies `/admin/v1` to `admin-server`.
 *
 * Its Content-Security-Policy is stricter than the user app's: no WebAssembly, no workers, no
 * blob: or data: media, and Trusted Types with no policy at all (nothing may build HTML).
 */
const ADMIN_API_TARGET = process.env['TESSERA_ADMIN_API_URL'] ?? 'http://127.0.0.1:8082';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const productionHeaders = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  // Security keys only (publickey-credentials-get/create are allowed by default for self).
  'Permissions-Policy':
    'camera=(), microphone=(), display-capture=(), geolocation=(), payment=(), usb=(), clipboard-read=()',
};

/**
 * Writes the production response headers next to the build (`dist/security-headers.json`), so
 * the server that serves the bundle in production (infra/images, nginx) sends exactly these.
 */
function securityHeaders(): Plugin {
  return {
    name: 'tessera-security-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'security-headers.json',
        source: `${JSON.stringify(productionHeaders, null, 2)}\n`,
      });
    },
  };
}

const proxy = { '/admin/v1': { target: ADMIN_API_TARGET, changeOrigin: false, xfwd: true } };

export default defineConfig({
  plugins: [react(), securityHeaders()],
  build: {
    sourcemap: true,
    modulePreload: { polyfill: false }, // the polyfill injects inline script
    assetsInlineLimit: 0,
  },
  server: { port: 5174, strictPort: true, proxy },
  preview: { port: 4174, strictPort: true, proxy, headers: productionHeaders },
});
