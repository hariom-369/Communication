// Checks what a Tessera web deployment serves against its signed release manifest
// (docs/e2ee.md §7, ADR-052). For independent monitors and for our own release pipeline:
//
//   node scripts/verify-release.mjs https://app.tessera.example --key <base64 Ed25519 public key>
//
// Exit 0 only if release.json verifies under a given key (or, without --key, under the key it
// names — which proves integrity, not origin) and every listed file is served byte for byte.
import { createHash, createPublicKey, verify } from 'node:crypto';

const RELEASE_CONTEXT = 'tessera web release manifest v1\n';

const args = process.argv.slice(2);
const origin = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--key');
const keys = args.flatMap((arg, index) => (args[index - 1] === '--key' ? [arg] : []));
if (origin === undefined) {
  process.stderr.write('usage: verify-release.mjs <origin> [--key <base64>]...\n');
  process.exit(2);
}

const fetchBytes = async (path) => {
  const response = await fetch(new URL(path, origin), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
};

const manifest = await fetchBytes('/release.json');
const signature = Buffer.from((await fetchBytes('/release.json.sig')).toString().trim(), 'base64');
const release = JSON.parse(manifest.toString());
const candidates = keys.length > 0 ? keys : [release.signer];
const verifies = (key) => {
  try {
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'base64').toString('base64url') },
      format: 'jwk',
    });
    return verify(
      null,
      Buffer.concat([Buffer.from(RELEASE_CONTEXT), manifest]),
      publicKey,
      signature,
    );
  } catch {
    return false; // not an Ed25519 public key
  }
};
const verified = candidates.find(verifies);
if (verified === undefined) {
  process.stderr.write('FAIL: the release manifest signature does not verify\n');
  process.exit(1);
}
let failures = 0;
for (const [path, digest] of Object.entries(release.files)) {
  const served = createHash('sha256')
    .update(await fetchBytes(path))
    .digest('base64');
  if (served !== digest) {
    failures += 1;
    process.stderr.write(`FAIL: ${path} does not match the manifest\n`);
  }
}
process.stdout.write(
  `release ${String(release.sequence)} (${release.official ? 'official' : 'UNOFFICIAL'}), signed by ${verified}: ` +
    `${String(Object.keys(release.files).length - failures)}/${String(Object.keys(release.files).length)} files match\n`,
);
process.exit(failures === 0 ? 0 : 1);
