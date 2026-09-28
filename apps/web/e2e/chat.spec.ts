import { expect, test, type Browser, type Page } from '@playwright/test';

import { signUpWithPassword, trackCspViolations } from './support.js';

/**
 * Messaging transport end to end: two users, two browser contexts, the real API, realtime
 * service, PostgreSQL and Valkey. Runs against the development messaging build, which shows a
 * permanent "not end-to-end encrypted" banner (E2EE arrives in Phase 4).
 */

async function newUser(
  browser: Browser,
): Promise<{ page: Page; username: string; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, username: identity.username, close: () => context.close() };
}

async function startChat(page: Page, username: string): Promise<void> {
  await page.getByLabel('Start a chat').fill(username);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { name: `@${username}`, level: 2 })).toBeVisible();
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

test.describe('chat', () => {
  test('two users exchange messages in real time with delivery and read states', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    const violations = trackCspViolations(alice.page);

    await expect(alice.page.getByRole('note')).toContainText('not end-to-end encrypted');
    await startChat(alice.page, bob.username);
    await send(alice.page, 'Hello Bob 👋');

    // Bob is on the chat list: the conversation appears in real time with an unread badge.
    const item = bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) });
    await expect(item).toContainText('Hello Bob 👋');
    await expect(item.getByLabel('1 unread')).toBeVisible();
    // Delivered as soon as Bob's client stored it; read once he opens the conversation.
    await expect(bubble(alice.page, 'Hello Bob 👋')).toContainText('Delivered');
    await item.click();
    await expect(bubble(bob.page, 'Hello Bob 👋')).toBeVisible();
    await expect(bubble(alice.page, 'Hello Bob 👋')).toContainText('Read');

    // Typing indicator, then the reply.
    await bob.page.getByLabel('Message', { exact: true }).fill('Hi Ali');
    await expect(alice.page.getByText('typing…').first()).toBeVisible();
    await bob.page.getByLabel('Message', { exact: true }).fill('Hi Alice!');
    await bob.page.keyboard.press('Enter');
    await expect(bubble(alice.page, 'Hi Alice!')).toBeVisible();

    expect(violations).toEqual([]);
    await alice.close();
    await bob.close();
  });

  test('messages written offline are queued and delivered after reconnecting', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await startChat(alice.page, bob.username);
    await send(alice.page, 'first, online');
    await expect(
      bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }),
    ).toContainText('first, online');

    await alice.page.context().setOffline(true);
    await expect(
      alice.page
        .getByRole('status')
        .filter({ hasText: /Offline|Connecting/ })
        .first(),
    ).toBeVisible();
    await send(alice.page, 'written while offline');
    await expect(bubble(alice.page, 'written while offline')).toContainText(
      'Waiting for connection',
    );

    await alice.page.context().setOffline(false);
    await alice.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(bubble(alice.page, 'written while offline')).toContainText(/Delivered|Sent/, {
      timeout: 30_000,
    });
    await expect(
      bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }),
    ).toContainText('written while offline');
    await alice.close();
    await bob.close();
  });

  test('replies, reactions, edits and deletions reach the other side', async ({ browser }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await startChat(alice.page, bob.username);
    await startChat(bob.page, alice.username);
    await send(alice.page, 'Lunch at 1?');
    await expect(bubble(bob.page, 'Lunch at 1?')).toBeVisible();

    // Bob reacts and replies.
    await bubble(bob.page, 'Lunch at 1?').getByRole('button', { name: 'Message actions' }).click();
    await bob.page.getByRole('button', { name: 'React 👍' }).click();
    await expect(bubble(alice.page, 'Lunch at 1?').getByLabel('Reactions')).toContainText('👍');
    await bubble(bob.page, 'Lunch at 1?').getByRole('button', { name: 'Message actions' }).click();
    await bob.page.getByRole('button', { name: 'Reply' }).click();
    await send(bob.page, 'Make it 1:30');
    await expect(bubble(alice.page, 'Make it 1:30')).toContainText('Lunch at 1?');

    // Alice edits, then deletes her message for everyone.
    await bubble(alice.page, 'Lunch at 1?')
      .first()
      .getByRole('button', { name: 'Message actions' })
      .click();
    await alice.page.getByRole('button', { name: 'Edit' }).click();
    await alice.page.getByLabel('Message', { exact: true }).fill('Lunch at 1:30?');
    await alice.page.getByRole('button', { name: 'Save' }).click();
    await expect(bubble(bob.page, 'Lunch at 1:30?').first()).toContainText('edited');

    alice.page.once('dialog', (dialog) => void dialog.accept());
    await bubble(alice.page, 'Lunch at 1:30?')
      .first()
      .getByRole('button', { name: 'Message actions' })
      .click();
    await alice.page.getByRole('button', { name: 'Delete for everyone' }).click();
    await expect(bob.page.getByText('This message was deleted')).toBeVisible();
    await alice.close();
    await bob.close();
  });

  test('message text is rendered as text, never as markup', async ({ browser }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    let dialogs = 0;
    bob.page.on('dialog', (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    await startChat(alice.page, bob.username);
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    await send(alice.page, payload);
    await bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }).click();
    await expect(bubble(bob.page, payload)).toBeVisible();
    expect(await bob.page.locator('main img, main script').count()).toBe(0);
    expect(dialogs).toBe(0);
    await alice.close();
    await bob.close();
  });

  test('unknown usernames get a clear error', async ({ browser }) => {
    const alice = await newUser(browser);
    await alice.page.getByLabel('Start a chat').fill('nobody_has_this_name');
    await alice.page.getByRole('button', { name: 'Start' }).click();
    await expect(alice.page.getByRole('alert')).toContainText('No one with that username');
    await alice.close();
  });
});
