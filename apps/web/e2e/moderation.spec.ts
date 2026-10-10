import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  dbQuery,
  grantStaff,
  newIdentity,
  signIn,
  signUpWithPassword,
  trackCspViolations,
  waitForMail,
} from './support.js';

/**
 * Safety and moderation end to end (docs/moderation.md): reporting end-to-end encrypted messages
 * with verifiable evidence, blocking, the moderation console (evidence, action, second-reviewer
 * rules), suspension and appeal, grievances, and harmful-link warnings checked on the device.
 */

async function newUser(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, ...identity, close: () => context.close() };
}

async function startChat(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: 'Chats' }).click();
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

async function openChatWith(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: 'Chats' }).click();
  await page.getByRole('link', { name: new RegExp(`@${username}`) }).click();
  await expect(page.getByRole('heading', { name: `@${username}`, level: 2 })).toBeVisible();
}

async function staff(browser: Browser, role: 'moderator' | 'senior_moderator' | 'legal') {
  const person = await newUser(browser);
  await grantStaff(person.username, role);
  await person.page.reload();
  await person.page.getByRole('link', { name: 'Moderation' }).click();
  await expect(person.page.getByRole('heading', { name: 'Moderation', level: 1 })).toBeVisible();
  return person;
}

test.describe('safety and moderation', () => {
  test('a reported threat is verified, acted on, appealed and reviewed by someone else', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    const violations = trackCspViolations(alice.page);
    await startChat(alice.page, bob.username);
    await send(alice.page, 'Please stop messaging me.');
    await openChatWith(bob.page, alice.username);
    const threat = 'You will regret this, I know where you live';
    await send(bob.page, threat);
    await expect(bubble(alice.page, threat)).toBeVisible();

    // Alice reports the message from its actions, and blocks Bob at the same time.
    await bubble(alice.page, threat).getByRole('button', { name: 'Message actions' }).click();
    await bubble(alice.page, threat).getByRole('button', { name: 'Report' }).click();
    const dialog = alice.page.getByRole('dialog', { name: `Report @${bob.username}` });
    await dialog.getByLabel('What is wrong?').selectOption({ label: 'Threats of violence' });
    await expect(dialog.getByRole('checkbox', { name: new RegExp(threat) })).toBeChecked();
    await dialog.getByLabel('Earlier messages for context').selectOption({ label: 'Up to 3' });
    await dialog.getByLabel(`Also block @${bob.username}`).check();
    await dialog.getByRole('button', { name: 'Send report' }).click();
    await expect(dialog.getByText('Thank you for reporting')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(alice.page.getByText(`You blocked @${bob.username}`)).toBeVisible();

    // The server verified the franked message without being able to read the chat.
    const [report] = await dbQuery<{ verification: string }>(
      `SELECT r.verification FROM moderation_reports r JOIN users u ON u.id = r.reporter_id
       WHERE u.username = $1`,
      [alice.username],
    );
    expect(report?.verification).toBe('content_verified');

    // A moderator opens the case, then the evidence (recorded), and suspends Bob.
    const moderator = await staff(browser, 'moderator');
    const mod = moderator.page;
    await mod
      .getByRole('link', { name: new RegExp(`Threats of violence · @${bob.username}`) })
      .click();
    await expect(mod.getByText(/Messages verified/)).toBeVisible();
    await expect(mod.getByText(threat)).toHaveCount(0);
    await mod.getByRole('button', { name: 'Open evidence (recorded)' }).click();
    await expect(mod.getByRole('list', { name: 'Reported messages' })).toContainText(threat);
    await expect(mod.getByRole('list', { name: 'Reported messages' })).toContainText(
      'Please stop messaging me.',
    );
    await mod.getByLabel('Action', { exact: true }).selectOption({ label: 'Suspension' });
    await mod.getByLabel('For how long').selectOption({ label: '3 days' });
    await mod.getByLabel('Internal note (not shown to the person)').fill('Threat after a no.');
    await mod.getByRole('button', { name: 'Apply' }).click();
    await expect(mod.getByText(/Suspension · .* · active/)).toBeVisible();

    // Bob was signed out; signing in again shows only the account status, where he appeals.
    await signIn(bob.page, bob);
    await expect(bob.page.getByText('Your account is suspended.')).toBeVisible();
    await expect(bob.page.getByRole('link', { name: 'Chats' })).toHaveCount(0);
    await expect(bob.page.getByText('Threat after a no.')).toHaveCount(0);
    await bob.page.getByRole('button', { name: 'Appeal this decision' }).click();
    await bob.page
      .getByLabel('Why should we look at this again?')
      .fill('It was a quote from a film, I can explain.');
    await bob.page.getByRole('button', { name: 'Send appeal' }).click();
    await expect(bob.page.getByText('Your appeal was sent.')).toBeVisible();

    // The moderator who decided cannot decide the appeal; a colleague overturns it.
    await mod.getByRole('link', { name: '← All cases' }).click();
    await mod.getByRole('tab', { name: 'Appeals' }).click();
    await mod.getByLabel('Reason (shown to the person)').fill('Upheld by myself');
    await mod.getByRole('button', { name: 'Uphold' }).click();
    await expect(mod.getByText(/someone who did not take the decision/)).toBeVisible();
    const reviewer = await staff(browser, 'moderator');
    await reviewer.page.getByRole('tab', { name: 'Appeals' }).click();
    await expect(reviewer.page.getByText(/quote from a film/)).toBeVisible();
    await reviewer.page.getByLabel('Reason (shown to the person)').fill('Context accepted.');
    await reviewer.page.getByRole('button', { name: 'Overturn' }).click();
    await expect(reviewer.page.getByText('No open appeals.')).toBeVisible();
    await bob.page.reload();
    await expect(bob.page.getByRole('link', { name: 'Chats' })).toBeVisible();

    // Alice still has Bob blocked, and can unblock him from her privacy settings.
    await alice.page.getByRole('link', { name: 'Privacy' }).click();
    await alice.page.getByRole('button', { name: `Unblock @${bob.username}` }).click();
    await expect(alice.page.getByText('You have not blocked anyone.')).toBeVisible();
    expect(violations).toEqual([]);
    for (const person of [alice, bob, moderator, reviewer]) await person.close();
  });

  test('warns about harmful links in chats, checked on the device', async ({ browser }) => {
    const moderator = await staff(browser, 'moderator');
    const host = `phish-${Date.now().toString(36)}.example`;
    await moderator.page.getByRole('tab', { name: 'Harmful links' }).click();
    await moderator.page.getByLabel('Host').fill(host);
    await moderator.page.getByRole('button', { name: 'Block host' }).click();
    await expect(moderator.page.getByText(`${host} · phishing`)).toBeVisible();

    const [alice, bob] = [await newUser(browser), await newUser(browser)];
    await startChat(alice.page, bob.username);
    await send(alice.page, 'hi');
    await openChatWith(bob.page, alice.username);
    await send(bob.page, `Your parcel is waiting: https://login.${host}/track`);
    await send(bob.page, 'and https://example.org is fine');
    await expect(bubble(alice.page, 'Your parcel')).toContainText('reported as harmful');
    await expect(bubble(alice.page, 'example.org is fine')).not.toContainText('harmful');
    for (const person of [moderator, alice, bob]) await person.close();
  });

  test('anyone can file a grievance and gets a reference by email', async ({ page }) => {
    const { email } = newIdentity();
    await page.goto('/grievance');
    await page
      .getByLabel('What is it about?')
      .selectOption({ label: 'Fake (deepfake) images or video of me' });
    await page.getByLabel('Your email address').fill(email);
    await page
      .getByLabel('What happened?')
      .fill('Someone posted a fake video of me in a public channel.');
    await page.getByRole('button', { name: 'Send complaint' }).click();
    await expect(page.getByText('We received your complaint')).toBeVisible();
    const reference = await page.locator('code').innerText();
    expect(await waitForMail(email, /Reference: ([0-9a-f-]{36})/)).toBe(reference);
  });
});
