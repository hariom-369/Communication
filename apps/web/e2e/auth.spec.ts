import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test } from '@playwright/test';

import {
  addVirtualAuthenticator,
  expireStepUp,
  inbox,
  newIdentity,
  signUpWithPassword,
  totp,
  trackCspViolations,
  waitForMail,
} from './support.js';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

test.describe('sign-up, sign-in and account security', () => {
  test('password sign-up, sign-out and sign-in under a strict CSP', async ({ page }) => {
    const violations = trackCspViolations(page);
    const response = await page.goto('/signup');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response?.headers()['content-security-policy']).toContain(
      "require-trusted-types-for 'script'",
    );

    const identity = await signUpWithPassword(page);
    await expect(
      page.getByRole('status').filter({ hasText: 'Your account is ready' }),
    ).toBeVisible();

    // Session cookie is HttpOnly and host-only: invisible to page scripts.
    expect(await page.evaluate(() => document.cookie)).toBe('');
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === '__Host-tsid')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.goto('/settings/security');
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email or username').fill(identity.username);
    await page.getByLabel('Password').fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByRole('alert')).toContainText('incorrect');

    await page.getByLabel('Password').fill(identity.password);
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByText('This device')).toBeVisible();

    expect(violations).toEqual([]);
  });

  test('passwordless sign-up and sign-in with a passkey', async ({ page }) => {
    await addVirtualAuthenticator(page);
    const identity = newIdentity();
    await page.goto('/signup');
    await page.getByLabel('Email').fill(identity.email);
    await page.getByLabel('Username').fill(identity.username);
    await page.getByLabel('I am 18 years or older.').check();
    await page.getByLabel(/I accept the Terms/).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page
      .getByLabel('Verification code')
      .fill(await waitForMail(identity.email, /verification code is: (\d{6})/));
    await page.getByRole('button', { name: 'Verify email' }).click();

    await page.getByRole('button', { name: 'Create a passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Passkeys' }).getByText(/^Chrome on /),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add password' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
  });

  test('two-step verification: enrol, confirm identity, sign in with a code and a recovery code', async ({
    page,
  }) => {
    const identity = await signUpWithPassword(page);
    await expireStepUp(); // force the "confirm it is you" dialog

    await page.getByRole('button', { name: 'Set up authenticator app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Password').fill(identity.password);
    await dialog.getByRole('button', { name: 'Confirm with password' }).click();
    await expect(dialog).toBeHidden();

    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    const secret = (await page.locator('code.secret').textContent()) ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel('Code from the app').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();

    const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
    await expect(codes).toHaveCount(10);
    const recoveryCode = (await codes.first().textContent()) ?? '';
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await expect(page.getByText('10 recovery codes left')).toBeVisible();

    // Authenticator code
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Email or username').fill(identity.email);
    await page.getByLabel('Password').fill(identity.password);
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await page.getByLabel('Authentication code').fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();

    // Recovery code, single use
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Email or username').fill(identity.email);
    await page.getByLabel('Password').fill(identity.password);
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(recoveryCode);
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByText('9 recovery codes left')).toBeVisible();
  });

  test('password reset from the emailed link signs out other sessions', async ({
    page,
    browser,
  }) => {
    const identity = await signUpWithPassword(page);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('/login');
    await otherPage.getByLabel('Email or username').fill(identity.email);
    await otherPage.getByLabel('Password').fill(identity.password);
    await otherPage.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(otherPage.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();

    const before = (await inbox(identity.email)).length;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.getByLabel('Email').fill(identity.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('Check your email');

    const link = await waitForMail(
      identity.email,
      /(http:\/\/localhost:4173\/reset-password#token=[A-Za-z0-9_-]{43})/,
      before,
    );
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password$/); // token removed from the address bar
    const newPassword = 'harbour-quartz-meadow-tangent-88';
    await page.getByLabel('New password').fill(newPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status')).toContainText('All sessions were signed out');

    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login$/);
    await other.close();

    await page.getByRole('link', { name: 'Sign in with your new password' }).click();
    await page.getByLabel('Email or username').fill(identity.email);
    await page.getByLabel('Password').fill(newPassword);
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
  });

  test('sessions can be signed out remotely', async ({ page, browser }) => {
    const identity = await signUpWithPassword(page);
    const other = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
    });
    const otherPage = await other.newPage();
    await otherPage.goto('/login');
    await otherPage.getByLabel('Email or username').fill(identity.email);
    await otherPage.getByLabel('Password').fill(identity.password);
    await otherPage.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(otherPage.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: 'Sign out Safari on iOS' }).click();
    await expect(page.getByText('Safari on iOS')).toBeHidden();
    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login$/);
    await other.close();
  });

  test('privacy settings persist', async ({ page }) => {
    await signUpWithPassword(page);
    await page.getByRole('link', { name: 'Privacy' }).click();
    await page.getByLabel('Last seen', { exact: true }).selectOption('nobody');
    await page.getByLabel(/Send read receipts/).uncheck();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Privacy settings saved.' }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Last seen', { exact: true })).toHaveValue('nobody');
    await expect(page.getByLabel(/Send read receipts/)).not.toBeChecked();
  });
});

test.describe('accessibility', () => {
  test('signed-out and signed-in pages have no detectable axe violations', async ({ browser }) => {
    // axe is injected as a script, which the production CSP (correctly) forbids; this context
    // bypasses CSP for the audit only. CSP itself is verified in the other tests.
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    const audit = async () => {
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: { run: () => Promise<{ violations: { id: string; nodes: unknown[] }[] }> };
          }
        ).axe;
        return (await axe.run()).violations.map(
          (violation) => `${violation.id} (${violation.nodes.length})`,
        );
      });
      expect(violations).toEqual([]);
    };
    for (const path of ['/login', '/signup', '/forgot-password']) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      await audit();
    }
    await signUpWithPassword(page);
    await page.getByText('This device').waitFor();
    await audit();
    await page.getByRole('link', { name: 'Privacy' }).click();
    await page.getByLabel('Last seen', { exact: true }).waitFor();
    await audit();
    // Chat list and an open conversation (development messaging build).
    const other = await browser.newContext();
    const peer = await signUpWithPassword(await other.newPage());
    await page.getByRole('link', { name: 'Chats' }).click();
    await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    await audit();
    await page.getByLabel('Start a chat').fill(peer.username);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByLabel('Message', { exact: true }).fill('Accessible?');
    await page.keyboard.press('Enter');
    await page.getByText('Sent', { exact: false }).first().waitFor();
    await audit();
    const screenshots = process.env['E2E_SCREENSHOTS'];
    if (screenshots !== undefined)
      await page.screenshot({ path: `${screenshots}/chat-desktop.png` });
    // Phone width: no horizontal page scroll, and the composer stays inside the viewport.
    await page.setViewportSize({ width: 360, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    const composer = await page.getByLabel('Message', { exact: true }).boundingBox();
    expect((composer?.y ?? Infinity) + (composer?.height ?? 0)).toBeLessThanOrEqual(740);
    await audit();
    if (screenshots !== undefined)
      await page.screenshot({ path: `${screenshots}/chat-mobile.png` });
    await other.close();
    await context.close();
  });

  test('keyboard users can skip navigation and headings receive focus on navigation', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create your account', level: 1 }),
    ).toBeFocused();

    await signUpWithPassword(page);
    await page.reload();
    await page.getByRole('heading', { name: 'Security', level: 1 }).waitFor();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });
});

test.describe('responsive layout @mobile', () => {
  test('settings are usable on a phone', async ({ page }) => {
    await signUpWithPassword(page);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
