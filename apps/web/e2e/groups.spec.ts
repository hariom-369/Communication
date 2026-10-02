import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

/**
 * End-to-end encrypted groups in real browsers (docs/groups.md): names and content never reach
 * the server, people are added only with an authenticated intent, roles live in the encryption
 * state, and an invite link only leads to an admin-approved request.
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
  await resetSignUpLimits();
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, ...identity };
}

type User = Awaited<ReturnType<typeof newUser>>;

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
    .getByRole('list', { name: /^Messages (in|with)/ })
    .getByRole('listitem')
    .filter({ hasText: text });

async function createGroup(page: Page, name: string, people: string[]): Promise<void> {
  await page.getByRole('link', { name: 'Chats' }).click();
  await page.getByRole('button', { name: 'New group' }).click();
  const dialog = page.getByRole('dialog', { name: 'New group' });
  await dialog.getByLabel('Group name').fill(name);
  await dialog.getByLabel('People').fill(people.join(', '));
  await dialog.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function openGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Chats' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function userId(username: string): Promise<string> {
  return database(async (client) => {
    const result = await client.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [
      username,
    ]);
    return result.rows[0]?.id ?? '';
  });
}

async function close(...users: User[]): Promise<void> {
  for (const user of users) await user.context.close();
}

test.describe('end-to-end encrypted groups', () => {
  test.setTimeout(120_000);

  test('a group: encrypted name, invitations, and no member the server makes up', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    const carol = await newUser(browser);
    const mallory = await newUser(browser);
    const violations = trackCspViolations(alice.page);
    // Carol is a contact (they have chatted), so Alice can add her directly; Bob is not, so his
    // default privacy setting turns the add into an invitation.
    await startChat(alice.page, carol.username);
    const name = `Rocket club ${Date.now()}`;
    await createGroup(alice.page, name, [bob.username, carol.username]);
    await expect(alice.page.getByText(/Invited \(they need to accept\)/)).toBeVisible();
    await send(alice.page, 'launch at dawn');

    await openGroup(carol.page, name);
    await expect(bubble(carol.page, 'launch at dawn')).toBeVisible();

    // Bob accepts the invitation; Alice's device adds him (her intent named him).
    await bob.page.reload();
    await bob.page
      .getByRole('region', { name: 'Group invitations' })
      .getByRole('button', { name: 'Join' })
      .click();
    await expect(bob.page.getByRole('heading', { name, level: 2 })).toBeVisible();
    await send(carol.page, 'welcome bob');
    await expect(bubble(bob.page, 'welcome bob')).toBeVisible();

    // Nothing readable reached the server: not the name, not the messages.
    const leaked = await database(async (client) => {
      const rows = await client.query<{ ciphertext: Buffer }>(
        `SELECT m.ciphertext FROM mailbox_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
         JOIN users u ON u.id = cm.user_id WHERE u.username = $1`,
        [alice.username],
      );
      const dump = await client.query<{ text: string }>(
        `SELECT row_to_json(c)::text AS text FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         JOIN users u ON u.id = cm.user_id WHERE u.username = $1`,
        [alice.username],
      );
      return (
        rows.rows.some(
          (row) =>
            row.ciphertext.includes(Buffer.from('Rocket club')) ||
            row.ciphertext.includes(Buffer.from('launch at dawn')),
        ) || dump.rows.some((row) => row.text.includes('Rocket club'))
      );
    });
    expect(leaked).toBe(false);

    // A malicious server lists Mallory as a member. No device adds her: no admin intended it.
    const groupId = alice.page.url().split('/').at(-1) ?? '';
    const malloryId = await userId(mallory.username);
    await database((client) =>
      client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, acked_seq)
         SELECT $1, $2, 'member', now(), last_seq FROM conversations WHERE id = $1`,
        [groupId, malloryId],
      ),
    );
    for (const user of [alice, bob, carol]) await user.page.reload();
    await openGroup(alice.page, name);
    await expect(alice.page.getByText(/not been confirmed by an admin yet/)).toBeVisible();
    await send(alice.page, 'still private');
    await expect(bubble(bob.page, 'still private')).toBeVisible();
    const welcomes = await database(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) FROM mls_welcomes WHERE conversation_id = $1 AND target_user_id = $2`,
        [groupId, malloryId],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    expect(welcomes).toBe(0);
    expect(violations).toEqual([]);
    await close(alice, bob, carol, mallory);
  });

  test('roles, announcement-only mode, polls and pins follow the encrypted group policy', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    const carol = await newUser(browser);
    await startChat(alice.page, bob.username);
    await startChat(alice.page, carol.username);
    const name = `Book club ${Date.now()}`;
    await createGroup(alice.page, name, [bob.username, carol.username]);
    await send(alice.page, 'first chapter');
    await openGroup(bob.page, name);
    await expect(bubble(bob.page, 'first chapter')).toBeVisible();
    await openGroup(carol.page, name);
    await expect(bubble(carol.page, 'first chapter')).toBeVisible();

    // Alice makes Bob an admin and turns on announcement-only mode.
    await alice.page.getByRole('button', { name: 'Details' }).click();
    const bobRow = alice.page.getByRole('listitem').filter({ hasText: `@${bob.username}` });
    await bobRow.getByRole('button', { name: 'Make admin' }).click();
    await expect(bobRow.getByText('Admin', { exact: true })).toBeVisible();
    await alice.page.getByLabel('Only admins can send messages').check();
    await alice.page.getByRole('button', { name: 'Save settings' }).click();
    await expect(alice.page.getByText('Saved.')).toBeVisible();

    await expect(
      carol.page.getByText('Only admins can send messages in this group.'),
    ).toBeVisible();
    await expect(carol.page.getByLabel('Message', { exact: true })).toHaveCount(0);
    // Bob, now an admin, can still post — and run a poll.
    await send(bob.page, 'admins only now');
    await expect(bubble(carol.page, 'admins only now')).toBeVisible();

    // Back to open chat; Carol votes in Bob's poll.
    await alice.page.getByLabel('Only admins can send messages').uncheck();
    await alice.page.getByRole('button', { name: 'Save settings' }).click();
    await expect(carol.page.getByLabel('Message', { exact: true })).toBeVisible();
    await bob.page.getByRole('button', { name: 'Poll' }).click();
    const poll = bob.page.getByRole('dialog', { name: 'New poll' });
    await poll.getByLabel('Question').fill('Next book?');
    await poll.getByLabel('Option 1').fill('Dune');
    await poll.getByLabel('Option 2').fill('Emma');
    await poll.getByRole('button', { name: 'Send poll' }).click();
    const carolPoll = carol.page.getByRole('group', { name: 'Next book?' });
    await carolPoll.getByRole('button', { name: /Emma/ }).click();
    await expect(
      bob.page.getByRole('group', { name: 'Next book?' }).getByRole('button', { name: /Emma/ }),
    ).toContainText('1 · 100%');

    // Pins: Carol (a member) is not offered pinning; Alice pins and everyone sees it.
    await bubble(carol.page, 'first chapter')
      .getByRole('button', { name: 'Message actions' })
      .click();
    await expect(carol.page.getByRole('button', { name: 'Pin' })).toHaveCount(0);
    await bubble(alice.page, 'first chapter')
      .getByRole('button', { name: 'Message actions' })
      .click();
    await alice.page.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(
      carol.page.getByRole('region', { name: 'Pinned messages' }).getByText('first chapter'),
    ).toBeVisible();
    await close(alice, bob, carol);
  });

  test('an invite link leads to a request that an admin approves', async ({ browser }) => {
    const alice = await newUser(browser);
    const dave = await newUser(browser);
    const name = `Hiking ${Date.now()}`;
    await createGroup(alice.page, name, []);
    await send(alice.page, 'trail at 8');
    await alice.page.getByRole('button', { name: 'Details' }).click();
    await alice.page.getByLabel(/Preview title/).fill('Weekend hikes');
    await alice.page.getByRole('button', { name: 'Create invite link' }).click();
    const link = (await alice.page.locator('code.secret').innerText()).trim();
    expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{22}$/);

    await dave.page.goto(new URL(link).pathname);
    await expect(dave.page.getByRole('heading', { name: 'Weekend hikes' })).toBeVisible();
    await dave.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(dave.page.getByText(/An admin of the group needs to approve it/)).toBeVisible();

    const requests = alice.page.getByRole('region', { name: /Requests to join/ });
    await requests.getByRole('button', { name: 'Approve' }).click();
    await dave.page.getByRole('link', { name: 'Chats' }).click();
    // Dave cannot read earlier history, but learns the name from the encrypted snapshot.
    await openGroup(dave.page, name);
    await send(alice.page, 'welcome dave');
    await expect(bubble(dave.page, 'welcome dave')).toBeVisible();
    await expect(bubble(dave.page, 'trail at 8')).toHaveCount(0);
    await close(alice, dave);
  });
});
