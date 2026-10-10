import { expect, test, type Page } from '@playwright/test';

import { signUpWithPassword } from './support.js';

/**
 * Web Vitals budgets (docs/performance.md): Largest Contentful Paint, Cumulative Layout Shift and
 * Interaction to Next Paint, measured in the browser with the standard performance entries on the
 * production build, with the CPU slowed four times to stand in for a mid-range phone. The "good"
 * thresholds of the Web Vitals programme are the budgets.
 */

const BUDGET = { lcp: 2500, cls: 0.1, inp: 200 };

interface Vitals {
  lcp: number;
  cls: number;
  inp: number;
}

/** Collects the metrics from the first moment of every document the page loads. */
async function observe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vitals = { lcp: 0, cls: 0, inp: 0 };
    (window as unknown as { __vitals: Vitals }).__vitals = vitals;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!entry.hadRecentInput) vitals.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    // INP: the slowest interaction (few interactions here, so the slowest is the 98th percentile).
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { interactionId?: number })[])
        if ((entry.interactionId ?? 0) > 0) vitals.inp = Math.max(vitals.inp, entry.duration);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });
}

async function vitals(page: Page): Promise<Vitals> {
  // LCP is final once the page has painted and been idle; let the observers flush.
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  return page.evaluate(() => (window as unknown as { __vitals: Vitals }).__vitals);
}

async function slowCpu(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

function withinBudget(measured: Vitals, label: string): void {
  const summary = `${label}: LCP ${measured.lcp.toFixed(0)} ms, CLS ${measured.cls.toFixed(3)}, INP ${measured.inp.toFixed(0)} ms`;
  test.info().annotations.push({ type: 'web-vitals', description: summary });
  process.stdout.write(`${summary}\n`);
  expect(measured.lcp, `${label} LCP`).toBeLessThanOrEqual(BUDGET.lcp);
  expect(measured.lcp, `${label} LCP measured`).toBeGreaterThan(0);
  expect(measured.cls, `${label} CLS`).toBeLessThanOrEqual(BUDGET.cls);
  expect(measured.inp, `${label} INP`).toBeLessThanOrEqual(BUDGET.inp);
}

test.describe('web vitals', () => {
  test('public pages load within budget, first visit and from the pinned copy', async ({
    page,
  }) => {
    await observe(page);
    await slowCpu(page);
    for (const path of ['/login', '/signup']) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      withinBudget(await vitals(page), `${path} (first visit)`);
    }
    // The service worker has pinned the release by now; later visits come from that copy.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    for (const path of ['/login', '/signup']) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      withinBudget(await vitals(page), `${path} (pinned)`);
    }
  });

  test('the signed-in app responds within budget', async ({ page }) => {
    await observe(page);
    await signUpWithPassword(page);
    await slowCpu(page);
    await page.goto('/chats');
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
    // Interactions: typing, and moving between sections from the navigation.
    await page.getByLabel('Start a chat').click();
    await page.keyboard.type('someone', { delay: 30 });
    await page.getByRole('link', { name: 'Account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Chats' }).click();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
    withinBudget(await vitals(page), '/chats (signed in)');
  });
});
