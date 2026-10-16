// Renders the nginx configuration that serves a built SPA (apps/web or apps/admin) in production:
//   node render.mjs --app web|admin --headers <dist>/security-headers.json [--root <dir>]
//                   [--sfu-upstream <host:port>] [--port 8080] [--health-port 8081]
//                   [--proxy /api/=<host:port> ...] [--media-origin https://<bucket host>]
// `--media-origin` adds the environment's object-storage origin to the CSP's connect-src
// (presigned uploads and downloads go straight to storage, docs/media.md §2), so one signed
// build serves every environment.
// `--proxy` adds further proxied prefixes for single-host use (the end-to-end tests run the
// suite against this server with E2E_WEB_SERVER=nginx); in production the load balancer routes
// /api and /rt to their services and only /sfu goes through here.
// The response headers are the ones the build wrote (vite.config.ts `productionHeaders`), so the
// production server sends exactly what the end-to-end tests check against `vite preview`.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    headers: { type: 'string' },
    root: { type: 'string', default: '/usr/share/nginx/html' },
    'sfu-upstream': { type: 'string' },
    port: { type: 'string', default: '8080' },
    'health-port': { type: 'string', default: '8081' },
    pid: { type: 'string', default: '/tmp/nginx.pid' },
    temp: { type: 'string', default: '/tmp' },
    mime: { type: 'string', default: '/etc/nginx/mime.types' },
    proxy: { type: 'string', multiple: true, default: [] },
    'media-origin': { type: 'string' },
  },
});
if (!['web', 'admin'].includes(args.app ?? '') || args.headers === undefined) {
  process.stderr.write('usage: render.mjs --app web|admin --headers <file> [options]\n');
  process.exit(2);
}
/** @type {unknown} */
const parsed = JSON.parse(readFileSync(args.headers, 'utf8'));
if (typeof parsed !== 'object' || parsed === null) throw new Error('headers: expected an object');
/** @type {Record<string, string>} */
const headers = {};
for (const [name, value] of Object.entries(parsed)) {
  if (typeof value !== 'string') throw new Error(`header ${name}: expected a string`);
  headers[name] = value;
}
const safe = /^[\x20-\x7e]*$/;
for (const [name, value] of Object.entries(headers))
  if (!/^[A-Za-z0-9-]+$/.test(name) || !safe.test(value) || /["\\$]/.test(value))
    throw new Error(`header ${name} cannot be written into nginx.conf safely`);
const mediaOrigin = args['media-origin'];
if (mediaOrigin !== undefined) {
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(mediaOrigin))
    throw new Error('--media-origin must be an origin like https://bucket.s3.region.amazonaws.com');
  const csp = headers['Content-Security-Policy'];
  if (csp === undefined || !/(^|; )connect-src [^;]*/.test(csp))
    throw new Error('--media-origin needs a Content-Security-Policy with connect-src');
  headers['Content-Security-Policy'] = csp.replace(
    /(^|; )(connect-src [^;]*)/,
    (_match, lead, directive) =>
      `${String(lead)}${String(directive)}${String(directive).includes(mediaOrigin) ? '' : ` ${mediaOrigin}`}`,
  );
}
const setsCacheControl = Object.keys(headers).some((h) => h.toLowerCase() === 'cache-control');
const securityHeaders = Object.entries(headers)
  .map(([name, value]) => `    add_header ${name} "${value}" always;`)
  .join('\n');
// nginx drops inherited add_header lines in a location that adds its own, so every location
// repeats the full set.
/** @type {(match: string, body: string[], cache?: string) => string} */
const location = (match, body, cache) =>
  [
    `  location ${match} {`,
    securityHeaders,
    ...(cache !== undefined && !setsCacheControl
      ? [`    add_header Cache-Control "${cache}" always;`]
      : []),
    ...body.map((line) => `    ${line}`),
    '  }',
  ].join('\n');

// Every file of the build is served: the signed release manifest pins each one (source maps and
// security-headers.json included), and the service worker and monitors fetch them all.
const locations = [
  // Hashed build output: cache for a year; a missing asset is a 404, never the app shell.
  location('/assets/', ['try_files $uri =404;'], 'public, max-age=31536000, immutable'),
  // Files that name the current release must always be revalidated.
  location(
    '~ ^/(sw\\.js|release\\.json|release\\.json\\.sig|index\\.html|manifest\\.webmanifest)$',
    ['try_files $uri =404;'],
    'no-cache',
  ),
  // Client-side routes fall back to the app shell.
  location('/', ['try_files $uri /index.html;'], 'no-cache'),
];
/** @type {(prefix: string, upstream: string, websocket: boolean) => string} */
const proxyLocation = (prefix, upstream, websocket) =>
  [
    `  location ${prefix} {`,
    `    proxy_pass http://${upstream};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $http_host;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    // The API refuses bodies over 64 KiB itself; files go straight to object storage.
    '    client_max_body_size 1m;',
    ...(websocket
      ? [
          '    proxy_set_header Upgrade $http_upgrade;',
          '    proxy_set_header Connection $connection_upgrade;',
          '    proxy_read_timeout 3600s;',
          '    proxy_send_timeout 3600s;',
          '    proxy_buffering off;',
        ]
      : []),
    '  }',
  ].join('\n');
for (const entry of args.proxy) {
  const match = /^(\/[a-z0-9/_-]*\/)=([a-z0-9.-]+:\d+)$/i.exec(entry);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new Error(`--proxy ${entry}: expected /prefix/=host:port`);
  locations.push(proxyLocation(match[1], match[2], true));
}
if (args.app === 'web') {
  if (args['sfu-upstream'] === undefined) throw new Error('--sfu-upstream is required for web');
  // LiveKit signalling under /sfu on the web origin (the CSP allows only 'self').
  locations.push(
    [
      '  location /sfu/ {',
      `    proxy_pass http://${args['sfu-upstream']}/;`,
      '    proxy_http_version 1.1;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection $connection_upgrade;',
      '    proxy_set_header Host $host;',
      '    proxy_read_timeout 3600s;',
      '    proxy_send_timeout 3600s;',
      '    proxy_buffering off;',
      '  }',
    ].join('\n'),
  );
}

const t = args.temp;
process.stdout.write(`# Generated by infra/images/nginx/render.mjs (${args.app}). Do not edit.
worker_processes auto;
pid ${args.pid};
error_log stderr warn;
events { worker_connections 4096; }
http {
  include ${args.mime};
  types { application/manifest+json webmanifest; }
  default_type application/octet-stream;
  # No access log: addresses belong to the security log pipeline (CloudFront/ALB logs).
  access_log off;
  server_tokens off;
  sendfile on;
  gzip on;
  gzip_types text/css application/javascript application/json application/wasm image/svg+xml application/manifest+json;
  client_max_body_size 1k;
  client_body_temp_path ${t}/client_body;
  proxy_temp_path ${t}/proxy;
  fastcgi_temp_path ${t}/fastcgi;
  uwsgi_temp_path ${t}/uwsgi;
  scgi_temp_path ${t}/scgi;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  server {
    listen ${args.port};
    root ${args.root};
    absolute_redirect off;
${locations.map((l) => l.replace(/^/gm, '  ')).join('\n')}
  }
  # Probes (not routed by the load balancer).
  server {
    listen ${args['health-port']};
    location ~ ^/(livez|readyz|startupz)$ { default_type text/plain; return 200 "ok"; }
    location / { return 404; }
  }
}
`);
