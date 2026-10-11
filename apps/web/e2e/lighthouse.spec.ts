import { chromium, expect, test } from '@playwright/test';
import lighthouse from 'lighthouse';

/**
 * Lighthouse budgets on the public pages (docs/performance.md): the production build, measured
 * with Lighthouse's default mobile profile (simulated mid-range phone on a slow 4G connection).
 * Signed-in pages are covered by the Web Vitals measurements (performance.spec.ts) and the
 * accessibility audit (accessibility.spec.ts).
 */

const WEB_URL = 'http://localhost:4173';
// Below 32768: outside the ephemeral range, where a connection can take the port first.
const PORT = 29_222;
const MINIMUM = { performance: 0.9, accessibility: 1, 'best-practices': 0.9 } as const;

test.describe('lighthouse', () => {
  test.setTimeout(180_000);

  test('public pages meet the budgets', async () => {
    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
    const browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [`--remote-debugging-port=${String(PORT)}`],
    });
    try {
      for (const path of ['/login', '/signup']) {
        const result = await lighthouse(`${WEB_URL}${path}`, {
          port: PORT,
          output: 'json',
          logLevel: 'error',
          onlyCategories: Object.keys(MINIMUM),
        });
        expect(result, path).toBeDefined();
        const { categories, audits } = result!.lhr;
        const scores = Object.fromEntries(
          Object.keys(MINIMUM).map((name) => [name, categories[name]?.score ?? 0]),
        ) as Record<keyof typeof MINIMUM, number>;
        const failing = Object.values(audits)
          .filter(
            (audit) =>
              audit.score !== null && audit.score < 1 && audit.scoreDisplayMode === 'binary',
          )
          .map((audit) => audit.id);
        const summary = `${path}: ${JSON.stringify(scores)}; LCP ${String(audits['largest-contentful-paint']?.displayValue)}, TBT ${String(audits['total-blocking-time']?.displayValue)}, CLS ${String(audits['cumulative-layout-shift']?.displayValue)}; failing: ${failing.join(', ') || 'none'}`;
        test.info().annotations.push({ type: 'lighthouse', description: summary });
        process.stdout.write(`${summary}\n`);
        for (const [name, minimum] of Object.entries(MINIMUM))
          expect(scores[name as keyof typeof MINIMUM], `${path} ${name}`).toBeGreaterThanOrEqual(
            minimum,
          );
      }
    } finally {
      await browser.close();
    }
  });
});
