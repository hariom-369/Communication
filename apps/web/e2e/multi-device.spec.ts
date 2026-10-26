import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  addVirtualAuthenticator,
  resetSignUpLimits,
  signUpWithPassword,
  trackCspViolations,
} from './support.js';

/**
 * Multi-device end-to-end encryption in real browsers (docs/multi-device.md,
 * docs/encrypted-backups.md): linking by code with history transfer, removing devices, and
 * encrypted backups restored with a recovery key or a passkey (WebAuthn PRF).
 */

async function newUser(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(connected(page)).toBeVisible();
  return { page, context, ...identity };
}

const connected = (page: Page) => page.getByRole('status').filter({ hasText: 'Connected' });

/** Signs in on a fresh browser, which has no encryption keys yet. */
async function signIn(browser: Browser, user: { username: string; password: string }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in with password' }).click();
  await expect(
    page.getByRole('heading', { name: 'Set up encryption on this device' }),
  ).toBeVisible();
  return { context, page };
}

async function startChat(page: Page, username: string): Promise<void> {
  await page.getByLabel('Start a chat').fill(username);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(
    page.getByRole('heading', { name: new RegExp(`@${username}`), level: 2 }),
  ).toBeVisible();
}

async function openChat(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: new RegExp(`@${username}`) }).click();
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

async function turnOnBackups(page: Page): Promise<string> {
  await page.goto('/settings/devices');
  await page.getByRole('button', { name: 'Turn on backups' }).click();
  const key = (await page.getByTestId('recovery-key').innerText()).trim();
  await page.getByLabel('I have saved my recovery key').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Last backup/ })).toBeVisible();
  return key;
}

test.beforeAll(async () => {
  await resetSignUpLimits();
});

test.describe('multiple devices', () => {
  test('links a second browser by code, with its history; both receive new messages; then it is removed', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await startChat(alice.page, bob.username);
    await send(alice.page, 'before linking');
    await openChat(bob.page, alice.username);
    await expect(bubble(bob.page, 'before linking')).toBeVisible();

    const laptop = await signIn(browser, alice);
    const violations = trackCspViolations(laptop.page);
    await laptop.page.getByLabel('Name for this device').fill('Work laptop');
    await laptop.page.getByRole('button', { name: 'Show link code' }).click();
    const code = (await laptop.page.getByTestId('link-code').innerText()).trim();
    expect(code.replaceAll('-', '')).toMatch(/^[A-Z2-7]{24}$/);

    // A wrong code is refused on the approving device (it would not match the new device's keys).
    await alice.page.goto('/settings/devices');
    // Same link id, different fingerprint (the last characters encode the fingerprint).
    const wrong = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    await alice.page.getByLabel('Link code').fill(wrong);
    await alice.page.getByRole('button', { name: 'Continue' }).click();
    await expect(alice.page.getByRole('alert')).toBeVisible();
    await expect(alice.page.getByText('wants to use your encrypted chats')).toHaveCount(0);

    await alice.page.getByLabel('Link code').fill(code.toLowerCase());
    await alice.page.getByRole('button', { name: 'Continue' }).click();
    await expect(
      alice.page.getByText('Work laptop wants to use your encrypted chats'),
    ).toBeVisible();
    await alice.page.getByRole('button', { name: 'Link device' }).click();
    await expect(alice.page.getByText('“Work laptop” is now linked.')).toBeVisible();

    // The laptop sets itself up and shows the transferred history.
    await expect(connected(laptop.page)).toBeVisible({ timeout: 20_000 });
    await openChat(laptop.page, bob.username);
    await expect(bubble(laptop.page, 'before linking')).toBeVisible();

    // Once a device has added it to the conversation, it receives new messages too.
    await openChat(bob.page, alice.username);
    await expect(bob.page.getByText(/added a new device/)).toBeVisible({ timeout: 20_000 });
    await send(bob.page, 'to all your devices');
    await expect(bubble(laptop.page, 'to all your devices')).toBeVisible({ timeout: 20_000 });
    await alice.page.goto('/chats');
    await openChat(alice.page, bob.username);
    await expect(bubble(alice.page, 'to all your devices')).toBeVisible({ timeout: 20_000 });
    await send(laptop.page, 'sent from the laptop');
    await expect(bubble(bob.page, 'sent from the laptop')).toBeVisible({ timeout: 20_000 });

    // Search runs over the history on this device.
    await laptop.page.getByLabel('Search messages').fill('LINKING');
    await expect(
      laptop.page.getByRole('list', { name: 'Search results' }).getByRole('button'),
    ).toHaveCount(1);
    await laptop.page.getByLabel('Search messages').fill('');

    // Removing the laptop signs it out of encrypted chats.
    await alice.page.goto('/settings/devices');
    await expect(
      alice.page.getByRole('list', { name: 'Devices' }).getByRole('listitem'),
    ).toHaveCount(2);
    alice.page.once('dialog', (dialog) => void dialog.accept());
    await alice.page.getByRole('button', { name: 'Remove device Work laptop' }).click();
    await expect(
      alice.page.getByRole('list', { name: 'Devices' }).getByRole('listitem'),
    ).toHaveCount(1);
    await laptop.page.reload();
    await expect(
      laptop.page.getByRole('heading', {
        name: 'This device was removed from your encrypted chats',
      }),
    ).toBeVisible();
    expect(violations).toEqual([]);
    await Promise.all([alice.context.close(), bob.context.close(), laptop.context.close()]);
  });

  test('restores a new browser from an encrypted backup with the recovery key', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await startChat(alice.page, bob.username);
    await send(alice.page, 'kept in the backup');
    await openChat(bob.page, alice.username);
    await expect(bubble(bob.page, 'kept in the backup')).toBeVisible();
    const recoveryKey = await turnOnBackups(alice.page);
    expect(recoveryKey.replaceAll('-', '')).toMatch(/^[A-Z2-7]{52}$/);

    const phone = await signIn(browser, alice);
    await phone.page.getByRole('button', { name: 'Restore from backup' }).click();
    // A wrong key does not unlock it.
    await phone.page.getByLabel('Recovery key').fill('A'.repeat(52));
    await phone.page.getByRole('button', { name: 'Restore with recovery key' }).click();
    await expect(phone.page.getByRole('alert')).toContainText('does not unlock your backup');

    await phone.page.getByLabel('Recovery key').fill(recoveryKey.toLowerCase());
    await phone.page.getByRole('button', { name: 'Restore with recovery key' }).click();
    await expect(connected(phone.page)).toBeVisible({ timeout: 20_000 });
    await openChat(phone.page, bob.username);
    await expect(bubble(phone.page, 'kept in the backup')).toBeVisible();

    // The restored device is a full member: it receives and sends new messages.
    await send(bob.page, 'welcome back');
    await expect(bubble(phone.page, 'welcome back')).toBeVisible({ timeout: 20_000 });
    await send(phone.page, 'restored and replying');
    await expect(bubble(bob.page, 'restored and replying')).toBeVisible({ timeout: 20_000 });
    await Promise.all([alice.context.close(), bob.context.close(), phone.context.close()]);
  });

  test('a passkey unlocks the backup after this browser’s data is wiped', async ({ browser }) => {
    const alice = await newUser(browser);
    await addVirtualAuthenticator(alice.page, { prf: true });
    await alice.page.goto('/settings/security');
    await alice.page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(alice.page.getByRole('list').getByText(/ on /)).toBeVisible();
    await turnOnBackups(alice.page);
    await alice.page.getByRole('button', { name: 'Unlock with a passkey' }).click();
    // Re-authentication, a PRF assertion and the key wrap: over 5 s on a busy CI runner.
    await expect(alice.page.getByText('Your passkey can now unlock backups.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      alice.page.getByRole('list', { name: 'Ways to unlock backups' }).getByRole('listitem'),
    ).toHaveCount(2);

    // Wipe every local database (the encrypted keys and history), as a browser reset would.
    await alice.page.goto('/settings/account');
    await alice.page.evaluate(async () => {
      const databases = await indexedDB.databases();
      await Promise.all(
        databases.map(
          (database) =>
            new Promise((resolve) => {
              const request = indexedDB.deleteDatabase(database.name ?? '');
              request.onsuccess = request.onerror = request.onblocked = resolve;
            }),
        ),
      );
    });
    await alice.page.goto('/chats');
    await expect(
      alice.page.getByRole('heading', { name: 'Set up encryption on this device' }),
    ).toBeVisible();
    await alice.page.getByRole('button', { name: 'Restore from backup' }).click();
    await alice.page.getByRole('button', { name: 'Restore with a passkey' }).click();
    await expect(connected(alice.page)).toBeVisible({ timeout: 20_000 });
    await alice.page.goto('/settings/devices');
    await expect(
      alice.page.getByRole('list', { name: 'Devices' }).getByRole('listitem'),
    ).toHaveCount(2);
    await alice.context.close();
  });
});
