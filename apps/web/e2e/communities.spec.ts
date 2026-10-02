import { expect, test, type Browser, type Page } from '@playwright/test';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

/**
 * Communities in real browsers (docs/groups.md §5): discovery, rules and the join gate, spaces as
 * end-to-end encrypted groups joined through an admin's device (automatically for open spaces),
 * and removal from every space when someone is removed from the community.
 */

async function newUser(browser: Browser) {
  await resetSignUpLimits();
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, ...identity };
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.keyboard.press('Enter');
}

const bubble = (page: Page, text: string) =>
  page
    .getByRole('list', { name: /^Messages (in|with)/ })
    .getByRole('listitem')
    .filter({ hasText: text });

async function createCommunity(
  page: Page,
  name: string,
  options: { rules: string; visibility: 'public' | 'private' },
): Promise<void> {
  await page.getByRole('link', { name: 'Communities' }).click();
  await page.getByRole('button', { name: 'Create a community' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a community' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Rules').fill(options.rules);
  await dialog
    .getByLabel('Who can find it')
    .selectOption(options.visibility === 'public' ? 'public' : 'private');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function createSpace(page: Page, name: string, autoApprove: boolean): Promise<void> {
  const form = page.getByRole('form', { name: 'New space' });
  await form.getByLabel('New space name').fill(name);
  if (autoApprove) await form.getByLabel(/Add eligible members automatically/).check();
  await form.getByRole('button', { name: 'Create space' }).click();
  await expect(
    page.getByRole('list', { name: 'Spaces' }).getByText(name, { exact: true }),
  ).toBeVisible();
}

const space = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Spaces' })
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) });

test.describe('communities', () => {
  test.setTimeout(150_000);

  test('discover, accept the rules, join spaces, and leave every space when removed', async ({
    browser,
  }) => {
    const owner = await newUser(browser);
    const alice = await newUser(browser);
    const violations = trackCspViolations(alice.page);
    const name = `Astronomy ${Date.now()}`;
    await createCommunity(owner.page, name, {
      rules: 'Be kind. No spoilers.',
      visibility: 'public',
    });
    await createSpace(owner.page, 'Lounge', true);
    await createSpace(owner.page, 'Observers', false);
    const communityUrl = owner.page.url();

    // Alice finds it in the directory and must accept the rules to join.
    await alice.page.getByRole('link', { name: 'Communities' }).click();
    await alice.page.getByLabel('Search public communities').fill(name.slice(0, 14));
    await alice.page.getByRole('link', { name }).click();
    await expect(alice.page.getByText('Be kind. No spoilers.')).toBeVisible();
    const joinButton = alice.page.getByRole('button', { name: 'Join community' });
    await expect(joinButton).toBeDisabled();
    await alice.page.getByLabel('I have read and accept the rules').check();
    await joinButton.click();
    await expect(alice.page.getByRole('heading', { name: 'Spaces' })).toBeVisible();

    // The open space: the owner's device adds her automatically.
    await space(alice.page, 'Lounge').getByRole('button', { name: 'Join Lounge' }).click();
    await expect(space(alice.page, 'Lounge').getByRole('link', { name: 'Open' })).toBeVisible({
      timeout: 30_000,
    });
    await space(alice.page, 'Lounge').getByRole('link', { name: 'Open' }).click();
    await expect(
      alice.page.getByRole('heading', { name: `${name} · Lounge`, level: 2 }),
    ).toBeVisible();
    await owner.page.getByRole('link', { name: 'Chats' }).click();
    await owner.page.getByRole('link', { name: new RegExp(`${name} · Lounge`) }).click();
    await send(owner.page, 'clear skies tonight');
    await expect(bubble(alice.page, 'clear skies tonight')).toBeVisible();

    // The approval space: she waits until an admin approves her request.
    await alice.page.goto(new URL(communityUrl).pathname);
    await space(alice.page, 'Observers').getByRole('button', { name: 'Join Observers' }).click();
    await expect(space(alice.page, 'Observers').getByText(/Requested/)).toBeVisible();
    await owner.page.getByRole('link', { name: 'Chats' }).click();
    await owner.page.getByRole('link', { name: new RegExp(`${name} · Observers`) }).click();
    await owner.page.getByRole('button', { name: 'Details' }).click();
    await owner.page
      .getByRole('region', { name: /Requests to join/ })
      .getByRole('button', { name: 'Approve' })
      .click();
    // Approving finishes once she is in the encryption group (messages before that are not hers).
    await expect(owner.page.getByText('No pending requests.')).toBeVisible();
    await send(owner.page, 'telescope at 9');
    await alice.page.getByRole('link', { name: 'Chats' }).click();
    await alice.page.getByRole('link', { name: new RegExp(`${name} · Observers`) }).click();
    await expect(bubble(alice.page, 'telescope at 9')).toBeVisible();

    // Removed from the community: out of every space.
    await owner.page.goto(new URL(communityUrl).pathname);
    owner.page.once('dialog', (dialog) => void dialog.accept());
    await owner.page
      .getByRole('region', { name: /^Members/ })
      .getByRole('listitem')
      .filter({ hasText: `@${alice.username}` })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(
      alice.page.getByText('You are no longer a member of this group.').first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(violations).toEqual([]);
    await owner.context.close();
    await alice.context.close();
  });

  test('a private community is reached only by invite link, gated by account age', async ({
    browser,
  }) => {
    const owner = await newUser(browser);
    const bob = await newUser(browser);
    const name = `Secret garden ${Date.now()}`;
    await createCommunity(owner.page, name, { rules: '', visibility: 'private' });
    const communityPath = new URL(owner.page.url()).pathname;

    // Not discoverable, not visible by id.
    await bob.page.getByRole('link', { name: 'Communities' }).click();
    await bob.page.getByLabel('Search public communities').fill('Secret garden');
    await expect(bob.page.getByText('No public communities match.')).toBeVisible();
    await bob.page.goto(communityPath);
    await expect(bob.page.getByText('This community does not exist or is private.')).toBeVisible();

    // A minimum account age keeps a brand-new account out even with a link.
    await owner.page.getByLabel('Minimum account age to join (days)').fill('7');
    await owner.page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(owner.page.getByText('Saved.')).toBeVisible();
    await owner.page.getByRole('button', { name: 'Create invite link' }).click();
    const link = (await owner.page.locator('code.secret').innerText()).trim();
    expect(link).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
    await bob.page.goto(new URL(link).pathname);
    await expect(bob.page.getByRole('heading', { name })).toBeVisible();
    await expect(bob.page.getByText('Accounts must be at least 7 days old to join.')).toBeVisible();
    await bob.page.getByRole('button', { name: 'Join community' }).click();
    await expect(bob.page.getByRole('alert')).toContainText('at least 7 days old');

    // Without the gate, the link works.
    await owner.page.getByLabel('Minimum account age to join (days)').fill('0');
    await owner.page.getByRole('button', { name: 'Save', exact: true }).click();
    await bob.page.getByRole('button', { name: 'Join community' }).click();
    await expect(bob.page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(bob.page.getByRole('heading', { name: 'Spaces' })).toBeVisible();
    await owner.context.close();
    await bob.context.close();
  });
});
