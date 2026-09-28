import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

import { signUpWithPassword, trackCspViolations } from './support.js';

/**
 * End-to-end encryption, in real browsers: MLS in the WebAssembly crypto worker under the
 * production CSP, against the real API and database.
 */

async function database<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env['TEST_DATABASE_URL'] ?? '');
  url.pathname = '/tessera_e2e';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function newUser(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, ...identity };
}

async function startChat(page: Page, username: string): Promise<void> {
  await page.getByLabel('Start a chat').fill(username);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(
    page.getByRole('heading', { name: new RegExp(`@${username}`), level: 2 }),
  ).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.keyboard.press('Enter');
}

const bubble = (page: Page, text: string) =>
  page
    .getByRole('list', { name: /^Messages with/ })
    .getByRole('listitem')
    .filter({ hasText: text });

test.describe('end-to-end encryption', () => {
  test('the server only ever stores ciphertext, and history survives its deletion', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    const violations = trackCspViolations(alice.page);
    await startChat(alice.page, bob.username);
    const secret = `meet at the north gate ${Date.now()}`;
    await send(alice.page, secret);
    await bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }).click();
    await expect(bubble(bob.page, secret)).toBeVisible();

    const rows = await database(async (client) => {
      const result = await client.query<{ ciphertext: Buffer; kind: number }>(
        `SELECT m.ciphertext, m.kind FROM mailbox_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
         JOIN users u ON u.id = cm.user_id WHERE u.username = $1`,
        [alice.username],
      );
      return result.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.kind === 2)).toBe(true); // the MLS commit that created the group
    for (const row of rows) {
      expect(row.ciphertext.includes(Buffer.from(secret))).toBe(false);
      expect(row.ciphertext.includes(Buffer.from('north gate'))).toBe(false);
    }

    // The server forgets everything; both devices still show the conversation after a reload.
    await database((client) =>
      client.query(
        `DELETE FROM mailbox_messages WHERE conversation_id IN (
           SELECT conversation_id FROM conversation_members cm JOIN users u ON u.id = cm.user_id
           WHERE u.username = $1)`,
        [alice.username],
      ),
    );
    for (const page of [alice.page, bob.page]) {
      await page.reload();
      await expect(bubble(page, secret)).toBeVisible();
    }
    expect(violations).toEqual([]);
    await alice.context.close();
    await bob.context.close();
  });

  test('both people see the same safety number and can mark each other verified', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await startChat(alice.page, bob.username);
    await send(alice.page, 'verify me');
    await bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }).click();
    await expect(bubble(bob.page, 'verify me')).toBeVisible();

    const numbers: string[] = [];
    for (const page of [alice.page, bob.page]) {
      await page.getByRole('button', { name: 'Details' }).click();
      const digits = page.getByLabel(/^Safety number with/);
      await expect(digits).toBeVisible();
      numbers.push((await digits.innerText()).replace(/\s+/g, ''));
    }
    expect(numbers[0]).toMatch(/^\d{60}$/);
    expect(numbers[0]).toBe(numbers[1]);

    await alice.page.getByRole('button', { name: 'Mark as verified' }).click();
    await expect(
      alice.page.getByRole('heading', { level: 2 }).filter({ hasText: 'Verified' }),
    ).toBeVisible();
    await alice.page.reload();
    await expect(
      alice.page.getByRole('heading', { level: 2 }).filter({ hasText: 'Verified' }),
    ).toBeVisible();
    await alice.context.close();
    await bob.context.close();
  });

  test('a new security key is set up on another device, and contacts must accept the change', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await startChat(alice.page, bob.username);
    await send(alice.page, 'before the reset');
    await bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }).click();
    await expect(bubble(bob.page, 'before the reset')).toBeVisible();

    // Bob signs in on a new browser: his keys are on the old one.
    const laptop = await browser.newContext();
    const bobLaptop = await laptop.newPage();
    await bobLaptop.goto('/login');
    await bobLaptop.getByLabel('Email or username').fill(bob.username);
    await bobLaptop.getByLabel('Password').fill(bob.password);
    await bobLaptop.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(
      bobLaptop.getByRole('heading', { name: 'Set up encryption on this device' }),
    ).toBeVisible();
    await bobLaptop.getByRole('button', { name: 'Create a new security key' }).click();
    await expect(bobLaptop.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();

    // Alice is warned, and her next message waits until she chooses to continue.
    await expect(
      alice.page.getByRole('alert').filter({ hasText: 'security key changed' }),
    ).toBeVisible();
    // The warning survives a reload until Alice acts on it.
    await alice.page.reload();
    await expect(
      alice.page.getByRole('alert').filter({ hasText: 'security key changed' }),
    ).toBeVisible();
    await send(alice.page, 'after the reset');
    await expect(bubble(alice.page, 'after the reset')).toContainText(/Waiting|Sending/);
    await alice.page.getByRole('button', { name: 'Continue' }).click();
    await expect(bubble(alice.page, 'after the reset')).toContainText(/Sent|Delivered|Read/, {
      timeout: 15_000,
    });

    // Bob's new device receives it; history from before stays on the old device only.
    await bobLaptop.getByRole('link', { name: new RegExp(`@${alice.username}`) }).click();
    await expect(bubble(bobLaptop, 'after the reset')).toBeVisible({ timeout: 15_000 });
    await expect(bubble(bobLaptop, 'before the reset')).toHaveCount(0);

    // The old device is signed out of encrypted chats.
    await bob.page.reload();
    await expect(
      bob.page.getByRole('heading', { name: 'This device was signed out of encrypted chats' }),
    ).toBeVisible();
    await alice.context.close();
    await bob.context.close();
    await laptop.close();
  });
});
