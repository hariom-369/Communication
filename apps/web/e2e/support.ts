import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

import type { CDPSession, Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import pg from 'pg';

const INBOX = 'http://127.0.0.1:28026';

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
export async function addVirtualAuthenticator(
  page: Page,
  { prf = false }: { prf?: boolean } = {},
): Promise<CDPSession> {
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
      // WebAuthn PRF (CTAP2 hmac-secret), used to unlock encrypted backups.
      ...(prf ? { hasPrf: true } : {}),
    },
  });
  return cdp;
}

/** Collects Content-Security-Policy violations reported by the browser. */
export function trackCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    // Chromium words Trusted Types reports in several ways ("Trusted Type", "TrustedScript",
    // "TrustedString"); all of them are violations.
    if (/Content Security Policy|Trusted ?(Type|Script|HTML|String)|unsafe-eval/i.test(text))
      violations.push(text);
  });
  return violations;
}

/**
 * Resets the per-IP sign-up and email-verification limits (30/hour each). Every browser in the
 * suite signs up from 127.0.0.1, so spec files that create many accounts call this first; the
 * limits themselves are tested in the API integration tests. Speaks RESP directly (no client
 * dependency).
 */
export async function resetSignUpLimits(): Promise<void> {
  const prefix = process.env['E2E_VALKEY_KEY_PREFIX'];
  const url = new URL(process.env['TEST_VALKEY_URL'] ?? 'redis://localhost:6379');
  if (prefix === undefined) throw new Error('E2E_VALKEY_KEY_PREFIX is not set (global setup)');
  const args = [
    'DEL',
    ...['signup', 'verify'].map((p) => `${prefix}:rl:accounts.${p}.ip:ip:127.0.0.1`),
  ];
  const command = `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(url.port || 6379), url.hostname, () => {
      socket.write(command);
    });
    socket.once('data', (reply) => {
      socket.end();
      if (reply.toString().startsWith(':')) resolve();
      else reject(new Error(`Valkey: ${reply.toString().trim()}`));
    });
    socket.once('error', reject);
  });
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
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
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
  await page.getByRole('heading', { name: 'Security', level: 1 }).waitFor();
  return identity;
}

/** Runs a query against the E2E database (setup and verification only). */
export async function dbQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = new URL(process.env['TEST_DATABASE_URL'] ?? '');
  url.pathname = '/tessera_e2e';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Grants a moderation role, as the operator command does (services/api/src/cli/staff-roles.ts). */
export async function grantStaff(
  username: string,
  role: 'moderator' | 'senior_moderator' | 'legal',
): Promise<void> {
  await dbQuery(
    `INSERT INTO staff_roles (user_id, role, granted_by, expires_at)
     SELECT id, $2, 'e2e', now() + interval '1 day' FROM users WHERE username = $1`,
    [username, role],
  );
}

export async function signIn(
  page: Page,
  identity: { email: string; password: string },
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identity.email);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Sign in with password' }).click();
}
