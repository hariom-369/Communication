// Fails if a production bundle built WITHOUT VITE_DEV_PLAINTEXT_MESSAGING contains the
// development (unencrypted) message codec or the chat UI that depends on it.
// Usage: node scripts/verify-bundle.mjs [distDir]
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = process.argv[2] ?? 'dist';
const FORBIDDEN = [
  'tessera-dev-plaintext-codec-v1',
  'Start a chat',
  'not</strong> end-to-end encrypted',
];

const assets = path.join(dist, 'assets');
const files = (await readdir(assets)).filter((name) => name.endsWith('.js'));
if (files.length === 0) throw new Error(`No JavaScript found in ${assets}; build first.`);

const found = [];
for (const file of files) {
  const source = await readFile(path.join(assets, file), 'utf8');
  for (const marker of FORBIDDEN) if (source.includes(marker)) found.push(`${file}: ${marker}`);
}
if (found.length > 0) {
  process.stderr.write(
    'Production bundle contains development-only messaging code:\n  ' + found.join('\n  ') + '\n',
  );
  process.exit(1);
}
process.stdout.write(
  `OK: ${files.length} bundle file(s) contain no development-only messaging code.\n`,
);
