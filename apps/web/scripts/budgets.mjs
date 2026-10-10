// Performance budgets for the production build (docs/performance.md). Runs after
// scripts/release.mjs as part of `pnpm build`, so a release over budget does not build. Sizes are
// gzip-compressed bytes (what crosses the network), except the shell total, which is what the
// service worker downloads and stores on install (see sw/release.ts).
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
export const BUDGETS = {
  /** Scripts the first page load runs (index.html's entry and its preloads). */
  entryScripts: 170 * KB,
  /** Stylesheets index.html loads. */
  stylesheets: 10 * KB,
  /** Any chunk loaded later (calls, …). */
  lazyChunk: 150 * KB,
  /** Each web worker script. */
  worker: 20 * KB,
  serviceWorker: 60 * KB,
  /** The encryption engine. */
  wasm: 850 * KB,
  html: 2 * KB,
  /** Everything the service worker pins (uncompressed, source maps excluded). */
  shellTotal: 4.8 * KB * KB,
};

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

async function files(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await files(path.join(dir, entry.name), relative)));
    else out.push(relative);
  }
  return out;
}

const all = (await files(dist)).filter((file) => !file.endsWith('.map'));
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const referenced = (pattern) => new Set([...html.matchAll(pattern)].map((match) => match[1]));
const entry = referenced(/<(?:script|link rel="modulepreload")[^>]*(?:src|href)="(\/[^"]+\.js)"/g);
const styles = referenced(/<link rel="stylesheet"[^>]*href="(\/[^"]+\.css)"/g);

const gzip = async (file) => gzipSync(await readFile(path.join(dist, file)), { level: 9 }).length;
const results = [];
const check = (name, size, budget) => results.push({ name, size, budget, ok: size <= budget });

let entryTotal = 0;
for (const file of entry) entryTotal += await gzip(file);
check(`entry scripts (${String(entry.size)})`, entryTotal, BUDGETS.entryScripts);
let styleTotal = 0;
for (const file of styles) styleTotal += await gzip(file);
check(`stylesheets (${String(styles.size)})`, styleTotal, BUDGETS.stylesheets);
for (const file of all) {
  if (entry.has(file)) continue;
  if (file === '/sw.js') check(file, await gzip(file), BUDGETS.serviceWorker);
  else if (file.endsWith('.wasm')) check(file, await gzip(file), BUDGETS.wasm);
  else if (file === '/index.html') check(file, await gzip(file), BUDGETS.html);
  else if (/worker-[^/]+\.js$/.test(file)) check(file, await gzip(file), BUDGETS.worker);
  else if (file.endsWith('.js')) check(file, await gzip(file), BUDGETS.lazyChunk);
}
let shell = 0;
for (const file of all) shell += (await stat(path.join(dist, file))).size;
check('pinned shell (uncompressed)', shell, BUDGETS.shellTotal);

const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;
for (const result of results)
  process.stdout.write(
    `${result.ok ? 'ok  ' : 'OVER'} ${result.name.padEnd(46)} ${kb(result.size).padStart(10)} / ${kb(result.budget)}\n`,
  );
const over = results.filter((result) => !result.ok);
if (entry.size === 0 || styles.size === 0) {
  process.stderr.write('budgets: could not find the entry script or stylesheet in index.html\n');
  process.exit(1);
}
if (over.length > 0) {
  process.stderr.write(`budgets: ${String(over.length)} over budget (docs/performance.md)\n`);
  process.exit(1);
}
