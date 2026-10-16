import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { render } from './render.js';
import { parseValues } from './values.js';

/**
 * Renders an environment: `node dist/cli.js --values <values.json> --out <dir>` writes
 * `<dir>/<environment>-1-prepare.yaml` and `<dir>/<environment>-2-workloads.yaml`. The values file is the Terraform root's `k8s_values` output plus
 * the release's image digest (the release workflow assembles it).
 */
const { values: args } = parseArgs({
  options: { values: { type: 'string' }, out: { type: 'string' } },
});
if (args.values === undefined || args.out === undefined) {
  process.stderr.write('usage: render --values <values.json> --out <dir>\n');
  process.exit(2);
}
const values = parseValues(JSON.parse(readFileSync(args.values, 'utf8')));
mkdirSync(args.out, { recursive: true });
const { prepare, workloads } = render(values);
for (const [suffix, text] of [
  ['1-prepare', prepare],
  ['2-workloads', workloads],
] as const) {
  const file = path.join(args.out, `${values.environment}-${suffix}.yaml`);
  writeFileSync(file, text);
  process.stdout.write(`${file}\n`);
}
