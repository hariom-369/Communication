import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

/**
 * End-to-end encrypted attachments in real browsers (docs/media.md): encrypted in the crypto
 * worker, uploaded straight to S3-compatible storage with presigned URLs, verified and decrypted
 * by the recipient. Chromium's fake media devices stand in for a microphone.
 */

test.use({
  launchOptions: {
    ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] === undefined
      ? {}
      : { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] }),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test.beforeAll(async () => {
  await resetSignUpLimits();
});

const LOCATION_TAG = 'TESSERA-GPS-48.8584N-2.2945E';

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
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, ...identity };
}

async function chat(
  alice: Awaited<ReturnType<typeof newUser>>,
  bob: Awaited<ReturnType<typeof newUser>>,
) {
  await alice.page.getByLabel('Start a chat').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Start' }).click();
  await alice.page.getByLabel('Message', { exact: true }).fill('hi');
  await alice.page.keyboard.press('Enter');
  await bob.page.getByRole('link', { name: new RegExp(`@${alice.username}`) }).click();
  await expect(bubble(bob.page, 'hi')).toBeVisible();
}

const bubble = (page: Page, text: string | RegExp) =>
  page
    .getByRole('list', { name: /^Messages with/ })
    .getByRole('listitem')
    .filter({ hasText: text });

/** A real JPEG (drawn by the browser) with an EXIF segment carrying a fake GPS tag. */
async function jpegWithExif(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(640, 480);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3366cc';
    context.fillRect(0, 0, 640, 480);
    context.fillStyle = '#ffcc00';
    context.fillRect(100, 100, 200, 150);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
  const jpeg = Buffer.from(base64, 'base64');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(LOCATION_TAG)]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId('attach-input').setInputFiles(files);
  for (const file of files)
    await expect(
      page.getByRole('list', { name: 'Attachments to send' }).getByText(file.name),
    ).toBeVisible();
}

async function storedObject(blobId: string): Promise<{ key: string; url: string }> {
  const key = await database(async (client) => {
    const result = await client.query<{ object_key: string }>(
      'SELECT object_key FROM media_blobs WHERE id = $1',
      [blobId],
    );
    return result.rows[0]?.object_key ?? '';
  });
  const bucket = process.env['E2E_MEDIA_BUCKET'] ?? '';
  return { key, url: `${process.env['TEST_S3_URL'] ?? ''}/${bucket}/${key}` };
}

async function latestBlobId(username: string): Promise<string> {
  return database(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT b.id FROM media_blobs b JOIN users u ON u.id = b.owner_id
       WHERE u.username = $1 ORDER BY b.created_at DESC LIMIT 1`,
      [username],
    );
    return result.rows[0]?.id ?? '';
  });
}

test.describe('encrypted attachments', () => {
  test('a photo is sent end-to-end encrypted with its location metadata removed', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    const violations = trackCspViolations(bob.page);
    await chat(alice, bob);
    const photo = await jpegWithExif(alice.page);
    expect(photo.includes(Buffer.from(LOCATION_TAG))).toBe(true);

    await attach(alice.page, [{ name: 'eiffel.jpg', mimeType: 'image/jpeg', buffer: photo }]);
    await alice.page.getByLabel('Message', { exact: true }).fill('from the tower');
    await alice.page.keyboard.press('Enter');
    await expect(bubble(alice.page, 'from the tower')).toContainText(/Sent|Delivered|Read/, {
      timeout: 20_000,
    });

    // Bob's device downloads, verifies and decrypts it; it renders as an image.
    const image = bubble(bob.page, 'from the tower').getByRole('img', {
      name: 'Photo: eiffel.jpg',
    });
    await expect(image).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(640);
    // What Bob received has no EXIF segment and no trace of the location tag.
    const [saved] = await Promise.all([
      bob.page.waitForEvent('download'),
      bubble(bob.page, 'from the tower')
        .getByRole('link', { name: 'Save Photo: eiffel.jpg' })
        .click(),
    ]);
    const { readFile } = await import('node:fs/promises');
    const received = await readFile(await saved.path());
    expect(received.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(received.includes(Buffer.from(LOCATION_TAG))).toBe(false);
    expect(received.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);

    // Storage holds only ciphertext: no JPEG markers, no metadata, not the pixels.
    const blobId = await latestBlobId(alice.username);
    const { url } = await storedObject(blobId);
    const stored = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(stored.subarray(0, 4).toString('latin1')).toBe('TSM1');
    expect(stored.includes(Buffer.from(LOCATION_TAG))).toBe(false);
    expect(stored.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    // The message preview names the attachment, never its content.
    await expect(
      alice.page.getByRole('link', { name: new RegExp(`@${bob.username}`) }),
    ).toContainText('📷 Photo · from the tower');
    expect(violations).toEqual([]);
    await Promise.all([alice.context.close(), bob.context.close()]);
  });

  test('files download intact; dangerous types are flagged; tampered ciphertext is refused', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await chat(alice, bob);
    const notes = Buffer.from('meeting notes\n'.repeat(5000));
    await attach(alice.page, [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: notes },
      {
        name: 'invite.html',
        mimeType: 'text/html',
        buffer: Buffer.from('<script>alert(1)</script>'),
      },
    ]);
    await alice.page.getByRole('button', { name: 'Send' }).click();

    const notesBubble = bubble(bob.page, 'notes.txt');
    await expect(notesBubble).toBeVisible({ timeout: 20_000 });
    const [download] = await Promise.all([
      bob.page.waitForEvent('download'),
      notesBubble.getByRole('button', { name: 'Download notes.txt' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('notes.txt');
    const path = await download.path();
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(path)).equals(notes)).toBe(true);

    // HTML is never rendered: it is a file with a warning, saved only on request.
    const html = bubble(bob.page, 'invite.html');
    await expect(html).toContainText('can run programs on your device');
    await expect(html.locator('iframe, object, embed')).toHaveCount(0);

    // A file larger than one upload part (8 MiB) goes up in several presigned parts.
    const { randomBytes } = await import('node:crypto');
    const archive = randomBytes(9 * 1024 * 1024 + 123);
    await attach(alice.page, [
      { name: 'archive.bin', mimeType: 'application/octet-stream', buffer: archive },
    ]);
    await alice.page.getByRole('button', { name: 'Send' }).click();
    const archiveBubble = bubble(bob.page, 'archive.bin');
    await expect(archiveBubble).toBeVisible({ timeout: 30_000 });
    const [big] = await Promise.all([
      bob.page.waitForEvent('download'),
      archiveBubble.getByRole('button', { name: 'Download archive.bin' }).click(),
    ]);
    expect((await readFile(await big.path())).equals(archive)).toBe(true);

    // The server swaps the stored ciphertext for something else: Bob's device refuses it.
    await attach(alice.page, [
      { name: 'contract.txt', mimeType: 'text/plain', buffer: Buffer.from('the real terms') },
    ]);
    await alice.page.getByRole('button', { name: 'Send' }).click();
    const contract = bubble(bob.page, 'contract.txt');
    await expect(contract).toBeVisible({ timeout: 20_000 });
    const { url } = await storedObject(await latestBlobId(alice.username));
    const original = Buffer.from(await (await fetch(url)).arrayBuffer());
    const tampered = Buffer.from(original);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 0xff;
    expect((await fetch(url, { method: 'PUT', body: tampered })).ok).toBe(true);
    await contract.getByRole('button', { name: 'Download contract.txt' }).click();
    await expect(contract).toContainText('could not be verified');
    await Promise.all([alice.context.close(), bob.context.close()]);
  });

  test('a voice message is recorded, sent and played back', async ({ browser }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await chat(alice, bob);
    await alice.page.getByRole('button', { name: 'Record a voice message' }).click();
    const recorder = alice.page.getByRole('group', { name: 'Recording a voice message' });
    await expect(recorder).toBeVisible();
    await alice.page.waitForTimeout(1500);
    await recorder.getByRole('button', { name: 'Send' }).click();

    const voice = bubble(bob.page, 'Voice message');
    await expect(voice).toBeVisible({ timeout: 20_000 });
    await voice.getByRole('button', { name: 'Play Voice message' }).click();
    // The player replaces the "Voice message" label, so locate it on the page.
    const audio = bob.page.locator('audio[aria-label="Voice message"]');
    await expect(audio).toBeAttached({ timeout: 20_000 });
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await Promise.all([alice.context.close(), bob.context.close()]);
  });
});
