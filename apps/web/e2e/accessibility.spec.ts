import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { grantStaff, signUpWithPassword } from './support.js';

/**
 * The WCAG 2.2 AA audit (docs/accessibility.md): every route, in the light and dark themes, at
 * desktop width and at 320 CSS pixels; automated rules (axe, WCAG 2.0–2.2 A/AA tags, including
 * target size), reflow, visible and unobscured keyboard focus, and the skip link. What automated
 * checks cannot judge is listed in the document with the manual checks done.
 */

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

const PUBLIC = ['/login', '/signup', '/forgot-password', '/grievance', '/no-such-page'];
const SIGNED_IN = [
  '/chats',
  '/communities',
  '/channels',
  '/settings/security',
  '/settings/devices',
  '/settings/privacy',
  '/settings/notifications',
  '/settings/account',
  '/settings/plan',
  '/settings/status',
  '/moderation',
];

async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async (tags) => {
    const engine = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: object,
          ) => Promise<{
            violations: { id: string; nodes: { target: unknown[] }[] }[];
          }>;
        };
      }
    ).axe;
    const result = await engine.run(document, { runOnly: { type: 'tag', values: tags } });
    return result.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .slice(0, 3)
          .map((node) => JSON.stringify(node.target))
          .join(' ')}`,
    );
  }, WCAG_TAGS);
}

/** 1.4.10 Reflow: no horizontal scrolling at 320 CSS pixels. */
function overflows(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * 2.4.7 Focus visible and 2.4.11 Focus not obscured: tab through the first controls; each must
 * show an outline (or ring) and must not be hidden behind anything else on the page.
 */
async function focusProblems(page: Page, steps = 12): Promise<string[]> {
  const problems: string[] = [];
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab');
    const problem = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null || element === document.body) return null;
      const name = `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? element.textContent).trim().slice(0, 30)}"`;
      const style = getComputedStyle(element);
      const ring =
        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1) ||
        style.boxShadow !== 'none';
      if (!ring) return `${name}: no visible focus indicator`;
      const box = element.getBoundingClientRect();
      const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      if (top !== null && top !== element && !element.contains(top) && !top.contains(element))
        return `${name}: covered by ${top.tagName.toLowerCase()}.${top.className}`;
      return null;
    });
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

/**
 * 1.4.12 Text spacing: with the criterion's spacing applied, nothing is cut off or overflows
 * its box (visually hidden text excepted).
 */
async function spacingProblems(page: Page): Promise<string[]> {
  await page.addStyleTag({
    content:
      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  });
  return page.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth)
      problems.push('page scrolls sideways');
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (element.closest('.t-visually-hidden, .skip-link') !== null) continue;
      // Visually hidden on purpose (screen-reader text: 1×1 px and clipped).
      const box = element.getBoundingClientRect();
      if (box.width <= 1 && box.height <= 1) continue;
      const text = element.textContent.trim();
      if (text === '' || element.offsetParent === null) continue;
      const style = getComputedStyle(element);
      const clips = (value: string) => value === 'hidden' || value === 'clip';
      if (
        (clips(style.overflowX) && element.scrollWidth > element.clientWidth + 1) ||
        (clips(style.overflowY) && element.scrollHeight > element.clientHeight + 1)
      )
        problems.push(
          `${element.tagName.toLowerCase()}.${element.className} cuts off "${text.slice(0, 30)}"`,
        );
    }
    return problems;
  });
}

async function auditPage(page: Page, path: string): Promise<string[]> {
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 800 });
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const where = `${path} ${scheme} ${String(width)}px`;
      for (const violation of await axe(page)) found.push(`${where} — ${violation}`);
      if (width === 320) {
        const overflow = await overflows(page);
        if (overflow > 0) found.push(`${where} — reflow: ${String(overflow)}px horizontal scroll`);
      }
      if (scheme === 'light') {
        for (const problem of await focusProblems(page)) found.push(`${where} — focus: ${problem}`);
        for (const problem of await spacingProblems(page))
          found.push(`${where} — text spacing: ${problem}`);
      }
    }
  }
  return found;
}

async function auditContext(browser: Browser) {
  // axe is injected as a script, which the production CSP (correctly) forbids; this context
  // bypasses CSP for the audit only.
  const context = await browser.newContext({ bypassCSP: true });
  return { context, page: await context.newPage() };
}

test.describe('WCAG 2.2 AA audit', () => {
  test.setTimeout(300_000);

  test('signed-out pages', async ({ browser }) => {
    const { context, page } = await auditContext(browser);
    const found: string[] = [];
    for (const path of PUBLIC) found.push(...(await auditPage(page, path)));
    await context.close();
    expect(found).toEqual([]);
  });

  test('signed-in pages', async ({ browser }) => {
    const { context, page } = await auditContext(browser);
    const me = await signUpWithPassword(page);
    await grantStaff(me.username, 'moderator');
    const found: string[] = [];
    for (const path of SIGNED_IN) found.push(...(await auditPage(page, path)));
    await context.close();
    expect(found).toEqual([]);
  });

  test('the skip link is the first stop and moves focus to the page content', async ({ page }) => {
    await signUpWithPassword(page);
    await page.goto('/chats');
    await page.getByRole('heading', { name: 'Chats', level: 1 }).waitFor();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.closest('#main') !== null)).toBe(true);
  });
});

/** Animations still running once the page has settled (infinite ones never finish). */
function running(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return (
          animation.playState === 'running' &&
          (timing?.iterations === Infinity || Number(timing?.duration ?? 0) > 1)
        );
      })
      .map((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const name = animation instanceof CSSAnimation ? animation.animationName : 'transition';
        return `${name} on ${target?.className ?? '?'}`;
      }),
  );
}

/** Puts one of each moving element on the page (the spinner and the loading placeholder). */
async function addMovingElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spinner = document.createElement('span');
    spinner.className = 't-button__spinner';
    const skeleton = document.createElement('span');
    skeleton.className = 't-skeleton';
    document.body.append(spinner, skeleton);
  });
}

test.describe('reduced motion', () => {
  test('nothing moves when the system asks for reduced motion', async ({ page }) => {
    await signUpWithPassword(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await addMovingElements(page);
    // The check sees animations when they are allowed …
    expect((await running(page)).length).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const path of ['/chats', '/communities', '/channels', '/settings/account']) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      await addMovingElements(page);
      // … and none when they are not (also any added later: the global rule in components.css).
      expect(await running(page), path).toEqual([]);
      const button = page.getByRole('button').first();
      expect(
        await button.evaluate((element) => getComputedStyle(element).transitionDuration),
      ).toMatch(/^(0s|1e-05s|0\.00001s)(, (0s|1e-05s|0\.00001s))*$/);
    }
  });
});
