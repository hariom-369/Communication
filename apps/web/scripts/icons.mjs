// Renders the install icons in public/icons from the mark in public/favicon.svg (run after
// changing the mark: `node scripts/icons.mjs`; the PNGs are committed). Uses the browser the
// end-to-end tests use, so no image tooling is needed.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mark = await readFile(path.join(root, 'public/favicon.svg'), 'utf8');
const BACKGROUND = '#fbf8f4';

/** `inset` is the share of each side left empty; maskable icons keep the mark in the safe zone. */
const icons = [
  { file: 'icon-192.png', size: 192, inset: 0.06, background: 'transparent' },
  { file: 'icon-512.png', size: 512, inset: 0.06, background: 'transparent' },
  { file: 'maskable-512.png', size: 512, inset: 0.2, background: BACKGROUND },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.12, background: BACKGROUND },
];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE === undefined
    ? {}
    : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
);
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const pad = Math.round(icon.size * icon.inset);
    await page.setContent(
      `<html><body style="margin:0;background:${icon.background}">` +
        `<div style="padding:${String(pad)}px;width:${String(icon.size - 2 * pad)}px;height:${String(icon.size - 2 * pad)}px">` +
        mark.replace('<svg ', '<svg width="100%" height="100%" ') +
        '</div></body></html>',
    );
    const png = await page.screenshot({ omitBackground: icon.background === 'transparent' });
    await writeFile(path.join(root, 'public/icons', icon.file), png);
    await page.close();
  }
} finally {
  await browser.close();
}
process.stdout.write(`icons: ${icons.map((icon) => icon.file).join(', ')}\n`);
