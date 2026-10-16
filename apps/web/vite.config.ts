import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { build, defineConfig, type InlineConfig, type Plugin, type Rollup } from 'vite';

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

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * The service worker (src/sw/sw.ts, push notifications) must be one classic script at a fixed
 * URL, `/sw.js`, so it is built separately: after the app in `vite build`, and on request (in
 * memory) by the dev server.
 */
function serviceWorkerBuild(outDir: string, write: boolean): InlineConfig {
  return {
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    // Only the wasm loader's default-path fallback reads it; the worker always passes a URL.
    define: { 'import.meta.url': 'self.location.href' },
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      write,
      sourcemap: true,
      assetsInlineLimit: 0,
      modulePreload: false,
      rollupOptions: {
        input: path.join(ROOT, 'src/sw/sw.ts'),
        output: { format: 'iife', entryFileNames: 'sw.js', inlineDynamicImports: true },
      },
    },
  };
}

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

function serviceWorker(): Plugin {
  let outDir = 'dist';
  let isBuild = false;
  return {
    name: 'tessera-service-worker',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      isBuild = config.command === 'build';
    },
    async closeBundle() {
      if (isBuild) await build(serviceWorkerBuild(outDir, true));
    },
    configureServer(server) {
      let files = new Map<string, Rollup.OutputAsset | Rollup.OutputChunk>();
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0] ?? '';
        if (url !== '/sw.js' && !(url.startsWith('/assets/') && files.has(url.slice(1)))) {
          next();
          return;
        }
        void (async () => {
          if (url === '/sw.js') {
            const output = (await build(serviceWorkerBuild(outDir, false))) as Rollup.RollupOutput;
            files = new Map(output.output.map((file) => [file.fileName, file]));
          }
          const file = files.get(url.slice(1));
          if (file === undefined) {
            next();
            return;
          }
          response.setHeader(
            'Content-Type',
            url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          );
          response.end(file.type === 'chunk' ? file.code : file.source);
        })().catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker(), securityHeaders()],
  worker: { format: 'es' },
  build: {
    sourcemap: true,
    modulePreload: { polyfill: false }, // the polyfill injects inline script
    assetsInlineLimit: 0, // no data: script/style inlining
    rolldownOptions: {
      output: {
        // Modules run in source order across chunks, so zod-config.ts (first import of main.tsx)
        // still runs before any schema in a shared chunk is created — otherwise Zod probes for
        // `Function`, a Trusted Types / CSP violation (docs/performance.md §2).
        strictExecutionOrder: true,
      },
    },
  },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy, headers: productionHeaders },
});
