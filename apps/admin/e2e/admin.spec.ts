import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { PEOPLE, STAFF } from './global-setup.js';
import { addSecurityKey, dbQuery, signIn, trackCspViolations } from './support.js';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * The admin console end to end (docs/admin.md, ADR-050): company identity provider, then a
 * hardware-bound security key; navigation by role; purpose-bound account views; four-eyes
 * approvals and just-in-time elevation; feature flags; the audit trail — under a strict CSP.
 */

async function staffPage(browser: Browser): Promise<{ page: Page; violations: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const violations = trackCspViolations(page);
  await addSecurityKey(page);
  return { page, violations };
}

/**
 * One browser per staff member for the whole file: their security key (a virtual authenticator)
 * lives in that browser, as a real key stays with its owner.
 */
const signedIn = new Map<string, { page: Page; violations: string[] }>();
async function as(browser: Browser, email: string): Promise<{ page: Page; violations: string[] }> {
  const existing = signedIn.get(email);
  if (existing !== undefined) {
    await existing.page.goto('/');
    await expect(existing.page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    return existing;
  }
  const fresh = await staffPage(browser);
  await signIn(fresh.page, email);
  signedIn.set(email, fresh);
  return fresh;
}

test.describe('admin console', () => {
  test('first sign-in registers a security key; support sees only support tools', async ({
    browser,
  }) => {
    const { page, violations } = await staffPage(browser);
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("trusted-types 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.getByRole('button', { name: 'Sign in with your company account' }).click();
    await page.getByLabel('Work email').fill(STAFF.sam.email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Register your security key' })).toBeVisible();
    // The authorization code does not stay in the address bar.
    expect(page.url()).not.toContain('code=');
    await page.getByRole('button', { name: 'Register key' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('link', { name: 'Tickets' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'People' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Admins' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Feature flags' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Your roles' })).toContainText('Support agent');

    // The session cookie is out of reach of scripts.
    expect(await page.evaluate(() => document.cookie)).not.toContain('tadm');
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === '__Host-tadm')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });

    // Without a purpose there is nothing to see: a ticket comes first.
    await nav.getByRole('link', { name: 'Tickets' }).click();
    const form = page.getByRole('form', { name: 'Open a ticket' });
    await form.getByLabel('Help-desk reference').fill('HD-4242');
    await form.getByLabel("The person's email or username").fill(PEOPLE[0].email);
    await form
      .getByLabel('What they asked for')
      .fill('Lost their phone; wants every session ended');
    await form.getByRole('button', { name: 'Open ticket' }).click();
    await expect(page.getByText('HD-4242')).toBeVisible();

    await nav.getByRole('link', { name: 'People' }).click();
    await page.getByLabel('Exact email, username or account id').fill(PEOPLE[1].username);
    await page
      .getByRole('combobox', { name: 'Ticket' })
      .selectOption({ label: `HD-4242 — ${PEOPLE[0].username}` });
    await page.getByRole('button', { name: 'Look up' }).click();
    // The ticket is about someone else: the account is not reachable for it.
    await expect(page.getByRole('alert')).toContainText('Not found');

    await page.getByLabel('Exact email, username or account id').fill(PEOPLE[0].username);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByRole('heading', { name: PEOPLE[0].username })).toBeVisible();
    await expect(page.getByText(PEOPLE[0].email)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page.getByText('Signed out of 0 session(s).')).toBeVisible();

    // Their own trail: every look is recorded with its purpose.
    await nav.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByText('You see your own actions only.')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin.user_detail' }).first()).toBeVisible();
    await expect(page.getByText(/purpose=ticket:/).first()).toBeVisible();

    // Sign out ends the session on the server.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    const sessions = await dbQuery<{ revoked: boolean }>(
      `SELECT s.revoked_at IS NOT NULL AS revoked FROM admin_sessions s
       JOIN admin_users a ON a.id = s.admin_id WHERE a.email = $1`,
      [STAFF.sam.email],
    );
    expect(sessions.every((s) => s.revoked)).toBe(true);
    expect(violations).toEqual([]);
  });

  test('a synced passkey is refused', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await addSecurityKey(page, { synced: true });
    await page.goto('/sign-in');
    await page.getByRole('button', { name: 'Sign in with your company account' }).click();
    await page.getByLabel('Work email').fill(STAFF.sync.email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Register key' }).click();
    await expect(page.getByRole('alert')).toContainText('Use a hardware security key');
    await page.goto('/');
    await expect(page).toHaveURL(/\/key$/);
    await context.close();
  });

  test('four eyes: a flag change needs a second admin, then takes effect', async ({ browser }) => {
    const alice = await as(browser, STAFF.alice.email);
    await alice.page
      .getByRole('navigation', { name: 'Admin' })
      .getByRole('link', { name: 'Feature flags' })
      .click();
    const request = alice.page.getByRole('form', { name: 'Change a flag' });
    await request.getByLabel('Flag').selectOption('link_previews');
    await request.getByLabel('Set to').selectOption('off');
    await request.getByLabel('Reason').fill('Preview fetcher incident INC-77');
    await request.getByRole('button', { name: 'Request change' }).click();
    await expect(request.getByText('Requested.')).toBeVisible();

    // The requester cannot approve their own request.
    await alice.page.getByRole('link', { name: 'Approvals' }).click();
    const own = alice.page.getByRole('listitem', { name: 'Set flag link_previews off' });
    await expect(own.getByRole('button', { name: 'Withdraw' })).toBeVisible();
    await expect(own.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    const bob = await as(browser, STAFF.bob.email);
    await bob.page.getByRole('link', { name: 'Approvals' }).click();
    const theirs = bob.page.getByRole('listitem', { name: 'Set flag link_previews off' });
    await theirs.getByLabel('Note (optional)').fill('Agreed');
    await theirs.getByRole('button', { name: 'Approve' }).click();
    await expect(theirs).toHaveCount(0);

    await alice.page.getByRole('link', { name: 'Feature flags' }).click();
    await expect(alice.page.getByRole('row', { name: /link_previews/ })).toContainText('off');
    const [flag] = await dbQuery<{ enabled: boolean }>(
      "SELECT enabled FROM feature_flags WHERE key = 'link_previews'",
    );
    expect(flag?.enabled).toBe(false);
    expect(alice.violations).toEqual([]);
    expect(bob.violations).toEqual([]);
  });

  test('just-in-time elevation: requested, approved by someone else, time-bound', async ({
    browser,
  }) => {
    const eve = await as(browser, STAFF.eve.email);
    const nav = eve.page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('link', { name: 'Security' })).toHaveCount(0);
    await eve.page.getByRole('button', { name: 'Request elevation' }).click();
    const dialog = eve.page.getByRole('dialog', { name: 'Request an elevated role' });
    await dialog.getByLabel('For how many hours').fill('2');
    await dialog.getByLabel('Why').fill('On call for incident INC-78');
    await dialog.getByRole('button', { name: 'Request' }).click();
    await expect(dialog.getByText('Requested')).toBeVisible();
    await dialog.press('Escape');

    const alice = await as(browser, STAFF.alice.email);
    await alice.page.getByRole('link', { name: 'Approvals' }).click();
    const item = alice.page.getByRole('listitem', {
      name: `Give ${STAFF.eve.email} the Security admin role for 2 h`,
    });
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(item).toHaveCount(0);

    await eve.page.reload();
    await expect(eve.page.getByRole('list', { name: 'Your roles' })).toContainText(
      /Security admin · ends in (1 h 5\d|2 h 0) min/,
    );
    await nav.getByRole('link', { name: 'Security' }).click();
    await expect(eve.page.getByRole('heading', { name: 'Failed sign-ins' })).toBeVisible();
  });

  test('security staff see the whole audit trail and the chain check', async ({ browser }) => {
    const alice = await as(browser, STAFF.alice.email);
    await alice.page.getByRole('link', { name: 'Audit log' }).click();
    await expect(alice.page.getByText('The audit chain verifies')).toBeVisible();
    await alice.page.getByLabel('Action').fill('admin.approval_approve');
    await alice.page.getByRole('button', { name: 'Filter' }).click();
    await expect(
      alice.page.getByRole('cell', { name: 'admin.approval_approve' }).first(),
    ).toBeVisible();
    await alice.page.getByRole('link', { name: 'Health' }).click();
    for (const name of ['database', 'cache', 'object storage', 'notification queue'])
      await expect(alice.page.getByText(new RegExp(`${name} · OK`))).toBeVisible();
  });

  test('accessible (axe) on every console page', async ({ browser }) => {
    // axe is injected as a script, which the production CSP (correctly) forbids; this context
    // bypasses CSP for the audit only. CSP itself is verified in the other tests.
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    await addSecurityKey(page);
    const audit = async (where: string) => {
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: { run: () => Promise<{ violations: { id: string; nodes: unknown[] }[] }> };
          }
        ).axe;
        return (await axe.run()).violations.map(
          (violation) => `${violation.id} (${String(violation.nodes.length)})`,
        );
      });
      expect(violations, where).toEqual([]);
    };
    await page.goto('/sign-in');
    await page.getByRole('heading', { level: 1 }).waitFor();
    await audit('/sign-in');
    await signIn(page, STAFF.ada.email);
    for (const path of [
      '/',
      '/people',
      '/tickets',
      '/approvals',
      '/admins',
      '/staff',
      '/flags',
      '/security',
      '/health',
      '/audit',
    ]) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      await page.waitForLoadState('networkidle');
      await audit(path);
    }
    await context.close();
  });
});
