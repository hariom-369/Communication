import { expect, test, type Browser, type Page } from '@playwright/test';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

/**
 * Every user-controlled string the app renders is shown as text, never as markup
 * (docs/testing.md §2, XSS; security review F-10): group names, file names, channel titles and
 * posts — message text is covered in chat.spec.ts. Each page counts dialogs (a payload that runs
 * calls alert), CSP / Trusted Types violations, and elements the payloads would inject.
 */
// Short enough for every field's length limit (group names stop at 80 characters).
const payload = (where: string) => `${where}<img src=x onerror=alert(1)><svg onload=alert(2)>`;

async function newUser(browser: Browser) {
  await resetSignUpLimits();
  const context = await browser.newContext();
  const page = await context.newPage();
  const watch = { dialogs: 0, violations: trackCspViolations(page) };
  page.on('dialog', (dialog) => {
    watch.dialogs += 1;
    void dialog.dismiss();
  });
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, watch, ...identity };
}

async function expectInert(page: Page, watch: { dialogs: number; violations: string[] }) {
  expect(await page.locator('img[src="x"], [onerror], [onload], main script').count()).toBe(0);
  expect(watch.dialogs).toBe(0);
  expect(watch.violations).toEqual([]);
}

test.describe('stored XSS', () => {
  test.setTimeout(120_000);

  test('group names, file names, channel titles and posts render as text', async ({ browser }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);

    // Contacts (they have chatted), so Alice adds Bob directly rather than inviting him.
    await alice.page.getByLabel('Start a chat').fill(bob.username);
    await alice.page.getByRole('button', { name: 'Start' }).click();
    await alice.page.getByLabel('Message', { exact: true }).fill('hi');
    await alice.page.keyboard.press('Enter');
    await expect(
      bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }),
    ).toBeVisible();

    // A group named with markup, seen by the other member.
    const groupName = payload('group');
    await alice.page.getByRole('button', { name: 'New group' }).click();
    const dialog = alice.page.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Group name').fill(groupName);
    await dialog.getByLabel('People').fill(bob.username);
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(alice.page.getByRole('heading', { name: groupName, level: 2 })).toBeVisible();

    // A file whose name is markup, sent into the group.
    const fileName = `${payload('file')}.txt`;
    await alice.page
      .getByTestId('attach-input')
      .setInputFiles([
        { name: fileName, mimeType: 'text/plain', buffer: Buffer.from('just text') },
      ]);
    await expect(
      alice.page.getByRole('list', { name: 'Attachments to send' }).getByText(fileName),
    ).toBeVisible();
    await alice.page.getByLabel('Message', { exact: true }).fill('a file');
    await alice.page.keyboard.press('Enter');

    await bob.page.getByRole('link', { name: 'Chats' }).click();
    await bob.page.getByRole('link').filter({ hasText: groupName }).click();
    await expect(bob.page.getByRole('heading', { name: groupName, level: 2 })).toBeVisible();
    await expect(bob.page.getByText(fileName)).toBeVisible();
    await expectInert(bob.page, bob.watch);

    // A channel with a markup title and post.
    const title = payload('title');
    const post = payload('post');
    await alice.page.getByRole('link', { name: 'Channels' }).click();
    await alice.page.getByRole('button', { name: 'Create a channel' }).click();
    const create = alice.page.getByRole('dialog', { name: 'Create a channel' });
    await create.getByLabel('Handle').fill(`xss${String(Date.now()).slice(-8)}`);
    await create.getByLabel('Title').fill(title);
    await create.getByLabel('Who can find it').selectOption('public');
    await create.getByRole('button', { name: 'Create' }).click();
    await expect(alice.page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    const composer = alice.page.getByRole('form', { name: 'New post' });
    await composer.getByLabel('Post', { exact: true }).fill(post);
    await composer.getByRole('button', { name: 'Publish' }).click();
    await expect(alice.page.getByRole('list', { name: 'Posts' }).getByText(post)).toBeVisible();
    await expectInert(alice.page, alice.watch);

    await alice.context.close();
    await bob.context.close();
  });
});
