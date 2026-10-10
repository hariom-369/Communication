import { expect, type CDPSession, type Page } from '@playwright/test';
import pg from 'pg';

/** A security key: Chromium's virtual roaming authenticator (USB, user-verifying, not synced). */
export async function addSecurityKey(
  page: Page,
  { synced = false }: { synced?: boolean } = {},
): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      // A synced passkey (password manager or phone account) is backup eligible and backed up.
      ...(synced ? { defaultBackupEligibility: true, defaultBackupState: true } : {}),
    },
  });
  return cdp;
}

/** Collects Content-Security-Policy and Trusted Types violations reported by the browser. */
export function trackCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Trusted ?(Type|Script|HTML|String)|unsafe-eval/i.test(text))
      violations.push(text);
  });
  return violations;
}

/** Signs in through the test identity provider's page and the security key step. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with your company account' }).click();
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  const register = page.getByRole('button', { name: 'Register key' });
  const use = page.getByRole('button', { name: 'Use security key' });
  await expect(register.or(use)).toBeVisible();
  await ((await register.isVisible()) ? register : use).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

export async function dbQuery<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env['E2E_ADMIN_DATABASE_URL'] });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}
