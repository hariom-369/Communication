import { expect, test, type Browser, type Page } from '@playwright/test';

import { resetSignUpLimits, signUpWithPassword } from './support.js';

/**
 * Group-call load (docs/calling.md §7): 32 real browser participants in one end-to-end encrypted
 * call through the real SFU — every device encrypts its own frames and decrypts everyone else's
 * (SFrame keyed from MLS).
 *
 * Modelled on a real meeting so that one machine can host every participant: four speakers with
 * cameras on, 28 listeners with microphones muted. Participants are spread over four browser
 * processes (Chromium opens the synthetic microphone for at most about 16 pages per process).
 *
 * Heavy, so opt-in: TESSERA_LOAD_TESTS=1 (PARTICIPANTS adjusts the size).
 */

const PARTICIPANTS = Number(process.env['PARTICIPANTS'] ?? 32);
const SPEAKERS = 4;
const PER_BROWSER = 8;

test.skip(process.env['TESSERA_LOAD_TESTS'] !== '1', 'set TESSERA_LOAD_TESTS=1 to run');

/** Progress for long runs (stdout of the test runner). */
function step(text: string): void {
  // eslint-disable-next-line no-console -- progress of a long, opt-in measurement
  console.log(`LOAD ${new Date().toISOString()} ${text}`);
}

async function newUser(browser: Browser, groupInvites: 'everyone' | 'contacts') {
  await resetSignUpLimits();
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  if (groupInvites === 'everyone') {
    // Allow being added directly to the group.
    await page.getByRole('link', { name: 'Privacy' }).click();
    await page.getByLabel('Group invitations').selectOption('everyone');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Privacy settings saved.')).toBeVisible();
  }
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, ...identity };
}

const callRegion = (page: Page) => page.getByRole('region', { name: 'Call' });
const tiles = (page: Page) =>
  callRegion(page).getByRole('list', { name: 'Participants' }).getByRole('listitem');

test('32 participants in one end-to-end encrypted group call', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  const browsers: Browser[] = [browser];
  for (let i = 1; i < Math.ceil(PARTICIPANTS / PER_BROWSER); i += 1) {
    browsers.push(
      await browser.browserType().launch({
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      }),
    );
  }
  const browserFor = (index: number) => browsers[Math.floor(index / PER_BROWSER)] ?? browser;

  const started = Date.now();
  const owner = await newUser(browserFor(0), 'contacts');
  const members = [];
  for (let i = 1; i < PARTICIPANTS; i += 1) {
    members.push(await newUser(browserFor(i), 'everyone'));
    step(`signed up ${i + 1}/${PARTICIPANTS}`);
  }
  const name = `All hands ${Date.now()}`;
  await owner.page.getByRole('button', { name: 'New group' }).click();
  const dialog = owner.page.getByRole('dialog', { name: 'New group' });
  await dialog.getByLabel('Group name').fill(name);
  await dialog.getByLabel('People').fill(members.map((m) => m.username).join(', '));
  await dialog.getByRole('button', { name: 'Create group' }).click();
  await expect(owner.page.getByRole('heading', { name, level: 2 })).toBeVisible({
    timeout: 120_000,
  });
  await owner.page.getByLabel('Message', { exact: true }).fill('starting the call');
  await owner.page.keyboard.press('Enter');
  for (const member of members) {
    await member.page.getByRole('link', { name: new RegExp(name) }).click({ timeout: 120_000 });
    await expect(member.page.getByText('starting the call', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
  }
  const setupMs = Date.now() - started;
  step(`group of ${PARTICIPANTS} ready in ${setupMs} ms`);

  // The owner and three members speak with cameras on; everyone else listens, muted.
  const callStart = Date.now();
  await owner.page.getByRole('button', { name: 'Video call' }).click();
  await expect(callRegion(owner.page).getByText(/Connected \d+:\d\d/)).toBeVisible({
    timeout: 60_000,
  });
  for (const [index, member] of members.entries()) {
    await member.page
      .getByRole('region', { name, exact: true })
      .getByRole('button', { name: 'Join call' })
      .click({ timeout: 60_000 });
    await expect(callRegion(member.page).getByText(/Connected \d+:\d\d/)).toBeVisible({
      timeout: 60_000,
    });
    if (index >= SPEAKERS - 1) {
      const controls = callRegion(member.page).getByRole('group', { name: 'Call controls' });
      await controls.getByRole('button', { name: 'Mute' }).click();
      await controls.getByRole('button', { name: 'Turn camera off' }).click();
    }
    step(`member ${index + 1} in the call`);
  }
  await expect(tiles(owner.page)).toHaveCount(PARTICIPANTS, { timeout: 3 * 60_000 });
  const joinedMs = Date.now() - callStart;

  // Every sampled device sees all participants and decrypts every speaker.
  const speakers = [owner, ...members.slice(0, SPEAKERS - 1)];
  const sample = [owner, ...members.filter((_, i) => i % 8 === 7)];
  const verifyStart = Date.now();
  for (const user of sample) {
    await expect(tiles(user.page)).toHaveCount(PARTICIPANTS, { timeout: 3 * 60_000 });
    for (const speaker of speakers) {
      if (speaker === user) continue;
      await expect(
        tiles(user.page).filter({ hasText: `@${speaker.username} · decrypting` }),
      ).toHaveCount(1, { timeout: 3 * 60_000 });
    }
    await expect(tiles(user.page).filter({ hasText: 'waiting for keys' })).toHaveCount(0);
    // The speakers' cameras are decoded from decrypted frames.
    await expect
      .poll(
        () =>
          user.page.evaluate(
            () =>
              [...document.querySelectorAll('video')].filter(
                (v) => v.videoWidth > 0 && v.getAttribute('aria-label')?.startsWith('Video from @'),
              ).length,
          ),
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(SPEAKERS - (speakers.includes(user) ? 1 : 0));
  }
  const verifyMs = Date.now() - verifyStart;

  const result = {
    participants: PARTICIPANTS,
    speakersWithCameras: SPEAKERS,
    browserProcesses: browsers.length,
    groupSetupMs: setupMs,
    allJoinedMs: joinedMs,
    sampleVerifiedMs: verifyMs,
    sampledDevices: sample.length,
  };
  test.info().annotations.push({ type: 'load', description: JSON.stringify(result) });
  step(JSON.stringify(result));
  for (const user of [owner, ...members]) await user.context.close();
  for (const extra of browsers.slice(1)) await extra.close();
});
