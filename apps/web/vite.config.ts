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
/** Group-call SFU (LiveKit, ADR-017), reached under `/sfu` on the web origin. */
const SFU_TARGET = process.env['TESSERA_SFU_URL'] ?? 'ws://127.0.0.1:7880';
/**
 * Object storage origin for encrypted attachments (presigned uploads and downloads go straight
 * from the browser to storage; docs/media.md §2). Deployments set it to the bucket's origin.
 */
const MEDIA_ORIGIN = process.env['TESSERA_MEDIA_ORIGIN'];
if (MEDIA_ORIGIN !== undefined && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(MEDIA_ORIGIN))
  throw new Error('TESSERA_MEDIA_ORIGIN must be an origin like https://media.example.com');

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  // WebAssembly compilation for the crypto worker (docs/security.md §3, ADR-006); no eval.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self'",
  // Decrypted attachments are shown from blob: URLs created in this origin; thumbnails are data:.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  `connect-src 'self'${MEDIA_ORIGIN === undefined ? '' : ` ${MEDIA_ORIGIN}`}`,
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
  // Microphone (voice messages, calls), camera and screen capture (calls), from this origin only;
  // each is asked for when the user starts recording or calling.
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()',
};

// Mirrors production routing: one origin, `/api` → API service, `/rt` → realtime service,
// `/sfu` → the SFU's signalling (media itself flows over UDP/TCP directly to the SFU).
const proxy = {
  '/api': { target: API_TARGET, changeOrigin: false, xfwd: true },
  '/rt': { target: REALTIME_TARGET, ws: true, changeOrigin: false },
  '/sfu': {
    target: SFU_TARGET,
    ws: true,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/sfu/, ''),
  },
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
