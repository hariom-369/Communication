import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The web app is a static bundle; in production it is served by the CDN with the API routed
 * under the same origin (`/api/*`). Locally, Vite proxies `/api` to the API service.
 *
 * The strict Content-Security-Policy (docs/security.md §3) is applied to `vite preview`, which
 * serves the production build and is what the end-to-end tests exercise. It is not applied to
 * the dev server because Vite's hot-reload runtime needs inline scripts.
 */
const API_TARGET = process.env['TESSERA_API_URL'] ?? 'http://127.0.0.1:8080';
const REALTIME_TARGET = process.env['TESSERA_REALTIME_URL'] ?? 'ws://127.0.0.1:8081';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  // WebAssembly compilation for the crypto worker (docs/security.md §3, ADR-006); no eval.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  // One policy, for the crypto worker's same-origin script URL (src/crypto/client.ts).
  'trusted-types tessera-worker',
].join('; ');

const productionHeaders = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

// Mirrors production routing: one origin, `/api` → API service, `/rt` → realtime service.
const proxy = {
  '/api': { target: API_TARGET, changeOrigin: false, xfwd: true },
  '/rt': { target: REALTIME_TARGET, ws: true, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    sourcemap: true,
    modulePreload: { polyfill: false }, // the polyfill injects inline script
    assetsInlineLimit: 0, // no data: script/style inlining
  },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy, headers: productionHeaders },
});
