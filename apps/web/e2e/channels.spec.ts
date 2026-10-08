import { expect, test, type Browser, type Page } from '@playwright/test';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

/**
 * Broadcast channels in real browsers (docs/channels.md): discovery, subscribing, posts with
 * polls and reactions, comments, scheduled publishing, analytics, private channels by invite
 * link, admin roles, and the SSRF-hardened link preview refusing internal addresses.
 */

async function newUser(browser: Browser) {
  await resetSignUpLimits();
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  return { page, context, ...identity };
}

async function createChannel(
  page: Page,
  handle: string,
  title: string,
  visibility: 'public' | 'private',
): Promise<void> {
  await page.getByRole('link', { name: 'Channels' }).click();
  await page.getByRole('button', { name: 'Create a channel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a channel' });
  await dialog.getByLabel('Handle').fill(handle);
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Who can find it').selectOption(visibility);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

async function publish(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('form', { name: 'New post' });
  await composer.getByLabel('Post', { exact: true }).fill(text);
  await composer.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('list', { name: 'Posts' }).getByText(text)).toBeVisible();
}

const postCard = (page: Page, text: string) =>
  page.getByRole('list', { name: 'Posts' }).getByRole('article').filter({ hasText: text });

test.describe('channels', () => {
  test.setTimeout(120_000);

  test('publish, discover, subscribe, react, vote, comment, schedule and see analytics', async ({
    browser,
  }) => {
    const owner = await newUser(browser);
    const reader = await newUser(browser);
    const violations = trackCspViolations(reader.page);
    const stamp = Date.now().toString(36);
    const title = `Weather ${stamp}`;
    await createChannel(owner.page, `wx_${stamp}`, title, 'public');
    await expect(owner.page.getByRole('note')).toContainText('not end-to-end encrypted');

    // A post with a poll.
    const composer = owner.page.getByRole('form', { name: 'New post' });
    await composer.getByLabel('Post', { exact: true }).fill('Storm warning for tonight');
    await composer.getByLabel('Add a poll').check();
    await composer.getByLabel('Question').fill('Are you ready?');
    await composer.getByLabel('Option 1').fill('Yes');
    await composer.getByLabel('Option 2').fill('Not yet');
    await composer.getByLabel(/Anonymous voting/).uncheck();
    // Internal addresses never get a preview (SSRF-hardened fetcher).
    await composer
      .getByLabel('Link to preview (optional)')
      .fill('https://169.254.169.254/latest/meta-data/');
    await composer.getByRole('button', { name: 'Check preview' }).click();
    await expect(composer.getByText(/No preview is available/)).toBeVisible();
    await composer.getByLabel('Link to preview (optional)').fill('');
    await composer.getByRole('button', { name: 'Publish' }).click();
    await expect(postCard(owner.page, 'Storm warning')).toBeVisible();

    // The reader finds it in the directory and subscribes.
    await reader.page.getByRole('link', { name: 'Channels' }).click();
    await reader.page.getByLabel('Search public channels').fill(`wx_${stamp}`);
    await reader.page.getByRole('link', { name: title }).click();
    await reader.page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(reader.page.getByRole('button', { name: 'Unsubscribe' })).toBeVisible();
    await expect(reader.page.getByText('2 subscribers')).toBeVisible();

    const card = postCard(reader.page, 'Storm warning');
    await card.getByRole('button', { name: 'React 🔥' }).click();
    await expect(card.getByRole('button', { name: 'React 🔥 (1)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await card.getByRole('button', { name: /Yes/ }).click();
    await expect(card.getByRole('button', { name: /Yes/ })).toContainText('1 · 100%');
    await card.getByRole('button', { name: 'Show voters' }).click();
    await expect(card.getByRole('list', { name: 'Voters' })).toContainText(`@${reader.username}`);
    await card.getByRole('button', { name: /Comments/ }).click();
    await card.getByLabel('Add a comment').fill('Batteries charged');
    await card.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(card.getByText('Batteries charged')).toBeVisible();

    // Scheduling: invisible to readers until it is due.
    const at = new Date(Date.now() + 20_000);
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 19);
    await composer.getByLabel('Post', { exact: true }).fill('Sunrise at 6:12');
    await composer.getByLabel('Schedule').check();
    await composer.getByLabel('Publish at').fill(local);
    await composer.getByRole('button', { name: 'Schedule' }).click();
    await owner.page.getByRole('tab', { name: 'Drafts and scheduled' }).click();
    await expect(owner.page.getByRole('list', { name: 'Scheduled posts' })).toContainText(
      'Sunrise at 6:12',
    );
    await reader.page.reload();
    await expect(postCard(reader.page, 'Storm warning')).toBeVisible();
    await expect(postCard(reader.page, 'Sunrise at 6:12')).toHaveCount(0);
    await expect(async () => {
      await reader.page.reload();
      await expect(postCard(reader.page, 'Sunrise at 6:12')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 45_000 });

    // Aggregate analytics for the owner (views are counted a few seconds after being seen).
    await reader.page.waitForTimeout(3500);
    await owner.page.getByRole('tab', { name: 'Analytics' }).click();
    const stats = owner.page.getByRole('region', { name: 'Recent posts' });
    await expect(stats.getByRole('row').filter({ hasText: 'Storm warning' })).toBeVisible();
    await expect(owner.page.getByText('2 subscribers')).toBeVisible();
    expect(violations).toEqual([]);
    await owner.context.close();
    await reader.context.close();
  });

  test('a private channel is reached by invite link, and admins can post', async ({ browser }) => {
    const owner = await newUser(browser);
    const guest = await newUser(browser);
    const stamp = Date.now().toString(36);
    const title = `Staff notes ${stamp}`;
    await createChannel(owner.page, `staff_${stamp}`, title, 'private');
    await publish(owner.page, 'Quarterly plan is out');
    const channelPath = new URL(owner.page.url()).pathname;

    // Not discoverable and not readable without the link.
    await guest.page.getByRole('link', { name: 'Channels' }).click();
    await guest.page.getByLabel('Search public channels').fill(`staff_${stamp}`);
    await expect(guest.page.getByText('No public channels match.')).toBeVisible();
    await guest.page.goto(channelPath);
    await expect(guest.page.getByText('This channel does not exist or is private.')).toBeVisible();

    await owner.page.getByRole('tab', { name: 'Settings' }).click();
    await owner.page.getByRole('button', { name: 'Create invite link' }).click();
    const link = (await owner.page.locator('code.secret').innerText()).trim();
    await guest.page.goto(new URL(link).pathname);
    await guest.page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(guest.page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(postCard(guest.page, 'Quarterly plan is out')).toBeVisible();
    await expect(guest.page.getByRole('form', { name: 'New post' })).toHaveCount(0);

    // Make the guest an admin who can post.
    const add = owner.page.getByRole('form', { name: 'Add an admin' });
    await add.getByLabel('Add an admin').fill(guest.username);
    await add.getByRole('button', { name: 'Add admin' }).click();
    await expect(
      owner.page.getByRole('region', { name: 'Admins' }).getByText(`@${guest.username}`),
    ).toBeVisible();
    await guest.page.reload();
    await publish(guest.page, 'Minutes from Monday');

    // Ownership changes are delayed and cancellable.
    await owner.page
      .getByLabel('Hand the channel to')
      .selectOption({ label: `@${guest.username}` });
    await owner.page.getByRole('button', { name: 'Hand over' }).click();
    await expect(owner.page.getByText('Ownership change pending')).toBeVisible();
    await owner.page.getByRole('button', { name: 'Cancel the change' }).click();
    await expect(owner.page.getByText('Ownership change pending')).toHaveCount(0);
    await owner.context.close();
    await guest.context.close();
  });
});
