// Signed web release (docs/e2ee.md §7, ADR-052, review item S-03). Runs after `vite build`:
//  1. adds Subresource Integrity (sha384) to every script and stylesheet in index.html;
//  2. writes the release number and the trusted release keys into sw.js (the service worker
//     verifies updates against them; it changes every release, so browsers fetch it);
//  3. writes dist/release.json — the SHA-256 of every served file — and signs it with Ed25519:
//     dist/release.json.sig = Ed25519(RELEASE_CONTEXT || release.json), base64.
//
// RELEASE_SIGNING_KEY: base64 PKCS#8 DER of the Ed25519 release key (CI, from the HSM-backed
// secret). Without it the build is signed by a throwaway key and marked unofficial — fine for
// development and tests, refused for publishing (RELEASE_REQUIRE_OFFICIAL=1).
// RELEASE_NEXT_KEYS: optional comma-separated base64 public keys trusted for later releases
// (key rotation: the current key vouches for the next one).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
/** Must equal packages/crypto-core/src/release.rs RELEASE_CONTEXT. */
const RELEASE_CONTEXT = 'tessera web release manifest v1\n';
// The minifier may write the placeholders with any quote style.
const KEYS_PLACEHOLDER = /(["'`])__TESSERA_RELEASE_KEYS__\1/g;
const SEQUENCE_PLACEHOLDER = /(["'`])__TESSERA_RELEASE_SEQUENCE__\1/g;

async function files(dir, prefix = '') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await files(path.join(dir, entry.name), relative)));
    else result.push(relative);
  }
  return result;
}

function rawPublicKey(key) {
  // The last 32 bytes of the SPKI encoding of an Ed25519 key are the raw public key.
  return createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
}

const configured = process.env.RELEASE_SIGNING_KEY;
if (process.env.RELEASE_REQUIRE_OFFICIAL === '1' && (configured === undefined || configured === ''))
  throw new Error('RELEASE_SIGNING_KEY is required for an official release');
const privateKey =
  configured === undefined || configured === ''
    ? generateKeyPairSync('ed25519').privateKey
    : createPrivateKey({ key: Buffer.from(configured, 'base64'), format: 'der', type: 'pkcs8' });
const signingPublic = rawPublicKey(privateKey);
const trusted = [
  signingPublic,
  ...(process.env.RELEASE_NEXT_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== ''),
];
// Strictly increasing per release: the service worker refuses to go back to an older one.
const sequence = Number(process.env.RELEASE_SEQUENCE ?? Date.now());
if (!Number.isSafeInteger(sequence) || sequence <= 0)
  throw new Error('RELEASE_SEQUENCE must be a positive integer');

// 1. Subresource Integrity in index.html.
const indexPath = path.join(DIST, 'index.html');
let index = await readFile(indexPath, 'utf8');
for (const match of index.matchAll(
  /<(script|link)\b[^>]*?(src|href)="(\/assets\/[^"]+\.(js|css))"[^>]*>/g,
)) {
  const [tag, , , asset] = match;
  if (tag.includes('integrity=')) continue;
  const bytes = await readFile(path.join(DIST, asset));
  const integrity = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  index = index.replace(tag, tag.replace(/>$/, ` integrity="${integrity}">`));
}
await writeFile(indexPath, index);

// 2. Release number and trusted keys in the service worker.
const swPath = path.join(DIST, 'sw.js');
const sw = await readFile(swPath, 'utf8');
if (sw.match(KEYS_PLACEHOLDER)?.length !== 1 || sw.match(SEQUENCE_PLACEHOLDER)?.length !== 1)
  throw new Error('sw.js has no release placeholders (was it built from src/sw/sw.ts?)');
await writeFile(
  swPath,
  sw
    .replace(KEYS_PLACEHOLDER, () => JSON.stringify(JSON.stringify(trusted)))
    .replace(SEQUENCE_PLACEHOLDER, () => String(sequence)),
);

// 3. The manifest of every served file, signed.
const digests = {};
for (const file of (await files(DIST)).sort()) {
  if (file === '/release.json' || file === '/release.json.sig') continue;
  digests[file] = createHash('sha256')
    .update(await readFile(path.join(DIST, file)))
    .digest('base64');
}
const manifest = Buffer.from(
  JSON.stringify({
    v: 1,
    sequence,
    version: process.env.BUILD_VERSION ?? '0.0.0-dev',
    commit: process.env.BUILD_COMMIT ?? 'unknown',
    official: configured !== undefined && configured !== '',
    signer: signingPublic,
    keys: trusted,
    files: digests,
  }),
);
const signature = sign(null, Buffer.concat([Buffer.from(RELEASE_CONTEXT), manifest]), privateKey);
await writeFile(path.join(DIST, 'release.json'), manifest);
await writeFile(path.join(DIST, 'release.json.sig'), signature.toString('base64'));
process.stdout.write(
  `release ${String(sequence)}: ${String(Object.keys(digests).length)} files, signed by ${signingPublic}${configured ? '' : ' (unofficial, throwaway key)'}\n`,
);
