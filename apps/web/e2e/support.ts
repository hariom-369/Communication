import { randomBytes } from 'node:crypto';

import type { CDPSession, Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import pg from 'pg';

const INBOX = 'http://127.0.0.1:58026';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export async function inbox(address: string): Promise<Mail[]> {
  const response = await fetch(`${INBOX}/?to=${encodeURIComponent(address)}`);
  return (await response.json()) as Mail[];
}

/** Polls the inbox until a message matching `pattern` arrives; returns the first capture group. */
export async function waitForMail(
  address: string,
  pattern: RegExp,
  previousCount = 0,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const messages = (await inbox(address)).slice(previousCount);
    for (const message of messages.reverse()) {
      const match = pattern.exec(message.text);
      if (match?.[1] !== undefined) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No mail matching ${String(pattern)} for ${address}`);
}

export function newIdentity(): { email: string; username: string; password: string } {
  const suffix = randomBytes(4).toString('hex');
  return {
    email: `e2e_${suffix}@example.test`,
    username: `e2e_${suffix}`,
    password: 'mosaic-lantern-orbit-velvet-52',
  };
}

export function totp(secret: string, offsetSteps = 0): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });
}

/** Adds Chromium's virtual platform authenticator (user-verifying, resident keys). */
export async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/** Collects Content-Security-Policy violations reported by the browser. */
export function trackCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Trusted Type/i.test(text)) violations.push(text);
  });
  return violations;
}

/** Makes every session look older than the step-up window (forces re-authentication). */
export async function expireStepUp(): Promise<void> {
  const url = new URL(process.env['TEST_DATABASE_URL'] ?? '');
  url.pathname = '/tessera_e2e';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query("UPDATE sessions SET reauthenticated_at = now() - interval '11 minutes'");
  await client.end();
}

export async function signUpWithPassword(
  page: Page,
  identity = newIdentity(),
): Promise<typeof identity> {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('I am 18 years or older.').check();
  await page.getByLabel(/I accept the Terms/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  const code = await waitForMail(identity.email, /verification code is: (\d{6})/);
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify email' }).click();
  await page.getByRole('heading', { name: 'Secure your account' }).waitFor();
  await page.getByLabel('New password').fill(identity.password);
  await page.getByLabel('Repeat password').fill(identity.password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await page.getByRole('heading', { name: 'Security' }).waitFor();
  return identity;
}
