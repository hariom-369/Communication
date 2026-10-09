import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type Page } from '@playwright/test';
import type * as LivekitClient from 'livekit-client';
import pg from 'pg';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

/**
 * Voice and video calls in real browsers (docs/calling.md §7): synthetic camera and microphone,
 * a real coturn relay and a real LiveKit SFU (e2e/global-setup.ts).
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

async function close(...users: User[]): Promise<void> {
  for (const user of users) await user.context.close();
}

const bubble = (page: Page, text: string | RegExp) =>
  page
    .getByRole('list', { name: /^Messages (in|with)/ })
    .getByRole('listitem')
    .filter({ hasText: text });

/** Alice and Bob with a working end-to-end encrypted chat, both looking at it. */
async function pair(browser: Browser) {
  const alice = await newUser(browser);
  const bob = await newUser(browser);
  await alice.page.getByLabel('Start a chat').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Start' }).click();
  await alice.page.getByLabel('Message', { exact: true }).fill('call me');
  await alice.page.keyboard.press('Enter');
  await bob.page.getByRole('link', { name: new RegExp(alice.username) }).click();
  await expect(bubble(bob.page, 'call me')).toBeVisible();
  return { alice, bob };
}

const callRegion = (page: Page) => page.getByRole('region', { name: 'Call' });

async function expectConnected(page: Page): Promise<void> {
  await expect(callRegion(page).getByText(/Connected \d+:\d\d/)).toBeVisible({ timeout: 30_000 });
}

/** Pixel width of the video playing in the element with this label (0 = no frames). */
function videoWidth(page: Page, label: RegExp): Promise<number> {
  return page.evaluate((source) => {
    const pattern = new RegExp(source);
    const video = [...document.querySelectorAll('video')].find((v) =>
      pattern.test(v.getAttribute('aria-label') ?? ''),
    );
    return video?.videoWidth ?? 0;
  }, label.source);
}

test.describe('1:1 calls', () => {
  test.setTimeout(150_000);

  test('a video call rings, connects through the relay with a verified fingerprint, and is kept in history', async ({
    browser,
  }) => {
    const { alice, bob } = await pair(browser);
    const violations = trackCspViolations(alice.page);
    await alice.page.getByRole('button', { name: 'Video call' }).click();
    await expect(callRegion(alice.page).getByText('Calling…')).toBeVisible();
    const ring = bob.page.getByRole('alertdialog', { name: 'Incoming call' });
    await expect(ring).toContainText(`@${alice.username} is calling you (video call)`);
    await ring.getByRole('button', { name: 'Accept' }).click();

    for (const page of [alice.page, bob.page]) {
      await expectConnected(page);
      // The DTLS certificate matched the fingerprint received end to end encrypted.
      await expect(callRegion(page).getByText(/connection verified/)).toBeVisible();
      // Default privacy: relayed unless the other person's safety number was verified.
      await expect(callRegion(page).getByText(/· relayed/)).toBeVisible({ timeout: 15_000 });
    }
    // Media really flows both ways.
    await expect.poll(() => videoWidth(alice.page, /^Video from/)).toBeGreaterThan(0);
    await expect.poll(() => videoWidth(bob.page, /^Video from/)).toBeGreaterThan(0);

    // Controls: mute, camera, screen share (replaces the camera picture), device switching.
    const controls = callRegion(alice.page).getByRole('group', { name: 'Call controls' });
    await controls.getByRole('button', { name: 'Mute' }).click();
    await expect(controls.getByRole('button', { name: 'Unmute' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await controls.getByRole('button', { name: 'Unmute' }).click();
    await controls.getByRole('button', { name: 'Turn camera off' }).click();
    await expect(controls.getByRole('button', { name: 'Turn camera on' })).toBeVisible();
    await controls.getByRole('button', { name: 'Turn camera on' }).click();
    await controls.getByRole('button', { name: 'Share screen' }).click();
    await expect(controls.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    await controls.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(controls.getByRole('button', { name: 'Share screen' })).toBeVisible();
    const microphone = callRegion(alice.page).getByLabel('Microphone');
    await microphone.selectOption({ index: 2 });
    await expect(callRegion(alice.page).getByRole('alert')).toHaveCount(0);
    await expectConnected(alice.page);

    await alice.page.waitForTimeout(1500);
    await controls.getByRole('button', { name: 'Hang up' }).click();
    await expect(bob.page.getByRole('status').filter({ hasText: 'Call ended.' })).toBeVisible();
    await expect(callRegion(bob.page)).toHaveCount(0);

    // History: on each device only, from the encrypted signalling.
    await expect(bubble(alice.page, /Outgoing video call · \d+ (s|min)/)).toBeVisible();
    await expect(bubble(bob.page, /Incoming video call · \d+ (s|min)/)).toBeVisible();

    // The server's record is minimal and it never saw a session description.
    const record = await database(async (client) => {
      const calls = await client.query<{
        end_reason: string;
        peak_participants: number;
        mode: string;
      }>(
        `SELECT c.end_reason, c.peak_participants, c.mode FROM calls c
           JOIN users u ON u.id = c.initiator_user_id WHERE u.username = $1`,
        [alice.username],
      );
      const leaks = await client.query<{ count: string }>(
        `SELECT count(*) FROM mailbox_messages WHERE position('a=fingerprint'::bytea in ciphertext) > 0`,
      );
      return { calls: calls.rows, leaks: Number(leaks.rows[0]?.count ?? -1) };
    });
    expect(record.calls).toEqual([{ end_reason: 'hangup', peak_participants: 2, mode: 'p2p' }]);
    expect(record.leaks).toBe(0);
    expect(violations).toEqual([]);
    await close(alice, bob);
  });

  test('declined and missed calls, and "who can call me"', async ({ browser }) => {
    const { alice, bob } = await pair(browser);
    // Declined.
    await alice.page.getByRole('button', { name: 'Voice call' }).click();
    const ring = bob.page.getByRole('alertdialog', { name: 'Incoming call' });
    await expect(ring).toContainText('(voice call)');
    await ring.getByRole('button', { name: 'Decline' }).click();
    await expect(
      alice.page.getByRole('status').filter({ hasText: 'Call declined.' }),
    ).toBeVisible();
    await expect(bubble(alice.page, 'Voice call declined')).toBeVisible();
    await expect(bubble(bob.page, 'You declined a voice call')).toBeVisible();

    // Missed: the caller gives up before anyone answers.
    await alice.page.getByRole('button', { name: 'Video call' }).click();
    await expect(ring).toBeVisible();
    await callRegion(alice.page).getByRole('button', { name: 'Hang up' }).click();
    await expect(ring).toHaveCount(0);
    await expect(bubble(bob.page, 'Missed video call')).toBeVisible();
    await expect(bubble(alice.page, 'Unanswered video call')).toBeVisible();

    // Bob stops accepting calls: refused by the server, with a reason.
    await bob.page.getByRole('link', { name: 'Privacy' }).click();
    await bob.page.getByLabel('Calls', { exact: true }).selectOption('nobody');
    await bob.page.getByRole('button', { name: 'Save' }).click();
    await expect(bob.page.getByText('Privacy settings saved.')).toBeVisible();
    await alice.page.getByRole('button', { name: 'Voice call' }).click();
    await expect(alice.page.getByRole('alert')).toContainText(
      `@${bob.username} does not accept calls.`,
    );
    await close(alice, bob);
  });

  test('a malicious server cannot substitute its own call offer (fingerprint substitution fails)', async ({
    browser,
  }) => {
    const { alice, bob } = await pair(browser);
    const mallory = await newUser(browser);
    // Mallory chats with Bob, so she holds a valid encryption group with him.
    await mallory.page.getByLabel('Start a chat').fill(bob.username);
    await mallory.page.getByRole('button', { name: 'Start' }).click();
    await mallory.page.getByLabel('Message', { exact: true }).fill('hello');
    await mallory.page.keyboard.press('Enter');
    await expect(bubble(mallory.page, 'hello')).toContainText(/Sent|Delivered|Read/);

    // The attacker's offer: a genuine, encrypted call offer carrying Mallory's DTLS fingerprint,
    // captured on its way to the server (and kept from reaching it).
    const forged = new Promise<string>((resolve) => {
      void mallory.page.route('**/api/v1/conversations/*/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON() as { ciphertext: string };
        resolve(body.ciphertext);
        await route.abort();
      });
    });
    await mallory.page.getByRole('button', { name: 'Video call' }).click();
    const attackerOffer = await forged;

    // The "server" now delivers Mallory's offer to Bob in place of Alice's real one, still
    // labelled as coming from Alice in the Alice–Bob chat.
    const aliceSends: string[] = [];
    alice.page.on('request', (request) => {
      if (request.method() === 'POST' && /\/conversations\/[^/]+\/messages$/.test(request.url()))
        aliceSends.push((request.postDataJSON() as { clientMessageId: string }).clientMessageId);
    });
    let substituted = 0;
    await bob.page.route('**/api/v1/conversations/*/messages?*', async (route) => {
      const response = await route.fetch();
      const page = (await response.json()) as {
        messages: { clientMessageId: string; ciphertext: string }[];
      };
      for (const message of page.messages) {
        if (aliceSends.includes(message.clientMessageId)) {
          message.ciphertext = attackerOffer;
          substituted += 1;
        }
      }
      await route.fulfill({ response, json: page });
    });

    await alice.page.getByRole('button', { name: 'Video call' }).click();
    await expect(callRegion(alice.page).getByText('Calling…')).toBeVisible();
    await expect.poll(() => substituted, { timeout: 20_000 }).toBeGreaterThan(0);
    // Bob's device cannot authenticate the substituted offer: it never rings, nothing connects.
    await bob.page.waitForTimeout(5000);
    await expect(bob.page.getByRole('alertdialog', { name: 'Incoming call' })).toHaveCount(0);
    await expect(
      bubble(bob.page, 'This message couldn’t be decrypted on this device.'),
    ).toBeVisible();
    await expect(callRegion(alice.page).getByText('Calling…')).toBeVisible();
    await callRegion(alice.page).getByRole('button', { name: 'Hang up' }).click();
    const answered = await database(async (client) => {
      const result = await client.query<{ answered_at: Date | null }>(
        `SELECT c.answered_at FROM calls c JOIN users u ON u.id = c.initiator_user_id
          WHERE u.username = $1`,
        [alice.username],
      );
      return result.rows.map((row) => row.answered_at);
    });
    expect(answered).toEqual([null]);
    await close(alice, bob, mallory);
  });

  test('the call survives a network change: ICE restarts through a fresh relay', async ({
    browser,
  }) => {
    const { alice, bob } = await pair(browser);
    const iceRequests: string[] = [];
    alice.page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/calls/ice')) iceRequests.push(request.url());
    });
    await alice.page.getByRole('button', { name: 'Video call' }).click();
    await bob.page
      .getByRole('alertdialog', { name: 'Incoming call' })
      .getByRole('button', { name: 'Accept' })
      .click();
    for (const page of [alice.page, bob.page]) await expectConnected(page);

    // The relay disappears, taking the call's network path with it (as when a phone moves from
    // Wi-Fi to mobile data), and a fresh relay with no allocations comes up.
    const pidFile = process.env['E2E_TURN_PIDFILE'] ?? '';
    const command = JSON.parse(process.env['E2E_TURN_COMMAND'] ?? '[]') as string[];
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
    await expect(callRegion(alice.page).getByText('Reconnecting…')).toBeVisible({
      timeout: 30_000,
    });
    const relay = spawn(command[0] ?? 'turnserver', command.slice(1), {
      stdio: 'ignore',
      detached: true,
    });
    relay.unref();

    // Only an ICE restart with fresh relay credentials can recover the call.
    for (const page of [alice.page, bob.page]) {
      await expect(callRegion(page).getByText(/Connected \d+:\d\d/)).toBeVisible({
        timeout: 45_000,
      });
    }
    expect(iceRequests.length).toBeGreaterThan(0);
    await expect(callRegion(alice.page).getByText(/connection verified/)).toBeVisible();
    await callRegion(alice.page).getByRole('button', { name: 'Hang up' }).click();
    await close(alice, bob);
  });
});

// ---- group calls ---------------------------------------------------------------------------------

/** HS256 join token for the SFU, minted the way the API does, for the inspecting test client. */
function sfuToken(room: string, identity: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: process.env['E2E_SFU_KEY'],
    sub: identity,
    name: identity,
    nbf: now - 10,
    exp: now + 600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
  })}`;
  const signature = createHmac('sha256', process.env['E2E_SFU_SECRET'] ?? '')
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

interface SeenFrame {
  kind: 'audio' | 'video';
  type: string | undefined;
  length: number;
  head: number[];
}

/**
 * A participant that the SFU lets in but the group never gave keys to: what it receives is what
 * the SFU forwards. It records the first bytes of every frame and publishes an unencrypted
 * microphone (which members must refuse to play).
 */
async function inspector(browser: Browser, callId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const client = readFileSync(
    new URL('../node_modules/livekit-client/dist/livekit-client.umd.js', import.meta.url),
    'utf8',
  );
  await page.route('http://localhost:58997/**', (route) =>
    route.request().url().endsWith('/livekit.js')
      ? route.fulfill({ contentType: 'text/javascript', body: client })
      : route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>inspector</title><script src="/livekit.js"></script>',
        }),
  );
  await page.goto('http://localhost:58997/');
  await page.evaluate(
    async ({ url, token }) => {
      const lk = (window as unknown as { LivekitClient: typeof LivekitClient }).LivekitClient;
      const seen: unknown[] = [];
      (window as unknown as { seen: unknown[] }).seen = seen;
      // Pass-through pipeline: records what arrives, sends its own microphone unencrypted.
      const worker = new Worker(
        URL.createObjectURL(
          new Blob(
            [
              `onmessage = (m) => {
                const { side, kind, readable, writable } = m.data;
                const reader = readable.getReader(), writer = writable.getWriter();
                (async () => { for (;;) {
                  const r = await reader.read(); if (r.done) return;
                  if (side === 'receive') {
                    const d = new Uint8Array(r.value.data);
                    postMessage({ kind, type: r.value.type, length: d.length, head: Array.from(d.slice(0, 32)) });
                  }
                  await writer.write(r.value);
                } })();
              };`,
            ],
            { type: 'text/javascript' },
          ),
        ),
      );
      worker.onmessage = (event) => {
        if (seen.length < 4000) seen.push(event.data);
      };
      interface Endpoint {
        createEncodedStreams(): { readable: ReadableStream; writable: WritableStream };
      }
      const pipe = (endpoint: unknown, side: string, kind: string) => {
        const { readable, writable } = (endpoint as Endpoint).createEncodedStreams();
        worker.postMessage({ side, kind, readable, writable }, [readable, writable]);
      };
      // Same frame access as the app (encoded streams), so nothing reaches a decoder unseen.
      const manager = {
        isEnabled: true,
        isDataChannelEncryptionEnabled: false,
        setup(room: InstanceType<typeof lk.Room>) {
          room.localParticipant.on(lk.ParticipantEvent.LocalSenderCreated, (sender, track) =>
            pipe(sender, 'send', track.kind),
          );
          room.on(lk.RoomEvent.TrackSubscribed, (track) =>
            pipe(track.receiver, 'receive', track.kind),
          );
        },
        setupEngine() {},
        setParticipantCryptorEnabled() {},
        setSifTrailer() {},
        encryptData: () => Promise.reject(new Error('unused')),
        handleEncryptedData: () => Promise.reject(new Error('unused')),
        on() {
          return this;
        },
      };
      const room = new lk.Room({ encryption: { e2eeManager: manager as never } });
      await room.setE2EEEnabled(true);
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
    },
    { url: process.env['E2E_SFU_URL'] ?? '', token: sfuToken(callId, 'inspector') },
  );
  return {
    context,
    frames: () => page.evaluate(() => (window as unknown as { seen: SeenFrame[] }).seen),
  };
}

/** Parses an SFrame header (RFC 9605 §4.3) at `offset`. */
function sframeHeader(bytes: number[], offset: number) {
  const config = bytes[offset];
  if (config === undefined) return null;
  let at = offset + 1;
  const read = (length: number) => {
    let value = 0n;
    for (let i = 0; i < length; i += 1) value = (value << 8n) | BigInt(bytes[at + i] ?? 0);
    at += length;
    return value;
  };
  const kid = (config & 0x80) === 0 ? BigInt((config >> 4) & 7) : read(((config >> 4) & 7) + 1);
  const ctr = (config & 0x08) === 0 ? BigInt(config & 7) : read((config & 7) + 1);
  return { kid, ctr, length: at - offset };
}

async function groupOf(browser: Browser, size: number) {
  const owner = await newUser(browser);
  const members: User[] = [];
  for (let i = 1; i < size; i += 1) {
    const member = await newUser(browser);
    // A direct chat first makes them contacts, so the owner can add them directly.
    await owner.page.getByLabel('Start a chat').fill(member.username);
    await owner.page.getByRole('button', { name: 'Start' }).click();
    members.push(member);
  }
  const name = `Standup ${Date.now()}`;
  await owner.page.getByRole('link', { name: 'Chats' }).click();
  await owner.page.getByRole('button', { name: 'New group' }).click();
  const dialog = owner.page.getByRole('dialog', { name: 'New group' });
  await dialog.getByLabel('Group name').fill(name);
  await dialog.getByLabel('People').fill(members.map((m) => m.username).join(', '));
  await dialog.getByRole('button', { name: 'Create group' }).click();
  await expect(owner.page.getByRole('heading', { name, level: 2 })).toBeVisible();
  await owner.page.getByLabel('Message', { exact: true }).fill('hello group');
  await owner.page.keyboard.press('Enter');
  for (const member of members) {
    await member.page.getByRole('link', { name: new RegExp(name) }).click();
    await expect(bubble(member.page, 'hello group')).toBeVisible();
  }
  return { owner, members, name };
}

test.describe('group calls (SFU, SFrame)', () => {
  test.setTimeout(240_000);

  test('members talk end to end encrypted through the SFU; what it forwards is ciphertext; removal re-keys', async ({
    browser,
  }) => {
    const { owner, members, name } = await groupOf(browser, 3);
    const [raj, bo] = members as [User, User];
    const violations = trackCspViolations(owner.page);
    await owner.page.getByRole('button', { name: 'Video call' }).click();
    await expectConnected(owner.page);
    const epoch = Number(
      /key epoch (\d+)/.exec(
        (await callRegion(owner.page)
          .getByText(/key epoch/)
          .textContent()) ?? '',
      )?.[1],
    );
    expect(epoch).toBeGreaterThan(0);

    // Raj joins from the invitation banner, Bo from the chat header.
    await raj.page
      .getByRole('status')
      .filter({ hasText: `A group call is going on in ${name}` })
      .getByRole('button', { name: 'Join call' })
      .click();
    await bo.page.getByRole('button', { name: 'Join call' }).click();
    for (const page of [owner.page, raj.page, bo.page]) {
      const tiles = callRegion(page)
        .getByRole('list', { name: 'Participants' })
        .getByRole('listitem');
      await expect(tiles).toHaveCount(3, { timeout: 30_000 });
      await expect(tiles.filter({ hasText: '· decrypting' })).toHaveCount(2, { timeout: 30_000 });
      await expect
        .poll(() => videoWidth(page, /^Video from @/), { timeout: 20_000 })
        .toBeGreaterThan(0);
    }

    // Screen sharing is a separate track, encrypted the same way.
    await callRegion(raj.page).getByRole('button', { name: 'Share screen' }).click();
    await expect(
      callRegion(owner.page).getByLabel(`Screen shared by @${raj.username}`),
    ).toBeVisible({
      timeout: 20_000,
    });

    // What the SFU forwards: a client admitted by the SFU but holding no group keys.
    const callId = await database(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT c.id FROM calls c JOIN users u ON u.id = c.initiator_user_id WHERE u.username = $1`,
        [owner.username],
      );
      return result.rows[0]?.id ?? '';
    });
    const spy = await inspector(browser, callId);
    await expect
      .poll(async () => (await spy.frames()).length, { timeout: 20_000 })
      .toBeGreaterThan(300);
    const frames = await spy.frames();
    const used = new Set<string>();
    let video = 0;
    for (const frame of frames) {
      // Audio is encrypted whole; VP8 keeps only its payload header (10 bytes on key frames,
      // 3 on others) in the clear, for the SFU.
      const prefix = frame.kind === 'audio' ? 0 : frame.type === 'key' ? 10 : 3;
      const header = sframeHeader(frame.head, prefix);
      expect(header).not.toBeNull();
      expect(Number(header!.kid % 16n)).toBe(epoch % 16);
      // Header + ciphertext + 16-byte tag (empty audio frames, from silence suppression, carry
      // just the header and tag).
      expect(frame.length).toBeGreaterThanOrEqual(prefix + header!.length + 16);
      // Every (key, counter) pair is used once: no nonce reuse across a sender's tracks.
      const nonce = `${header!.kid}:${header!.ctr}`;
      expect(used.has(nonce)).toBe(false);
      used.add(nonce);
      if (frame.kind === 'video') video += 1;
    }
    expect(video).toBeGreaterThan(50);
    // The inspector's own unencrypted microphone is never played by members.
    const intruder = callRegion(owner.page).getByRole('listitem').filter({ hasText: '@someone' });
    await expect(intruder).toContainText('waiting for keys', { timeout: 20_000 });

    // Bo is removed from the group: the group moves to a new epoch, the call re-keys, and Bo is
    // out of the call.
    await owner.page.getByRole('button', { name: 'Details' }).click();
    owner.page.once('dialog', (dialog) => void dialog.accept());
    await owner.page
      .getByRole('listitem')
      .filter({ hasText: `@${bo.username}` })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(callRegion(owner.page).getByText(`key epoch ${epoch + 1}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(callRegion(raj.page).getByText(`key epoch ${epoch + 1}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(callRegion(bo.page)).toHaveCount(0, { timeout: 60_000 });
    const tiles = callRegion(owner.page)
      .getByRole('list', { name: 'Participants' })
      .getByRole('listitem');
    await expect(tiles.filter({ hasText: `@${bo.username}` })).toHaveCount(0, { timeout: 30_000 });
    const before = (await spy.frames()).length;
    await expect.poll(async () => (await spy.frames()).length).toBeGreaterThan(before + 100);
    const later = (await spy.frames()).slice(before + 50);
    expect(
      later.every((f) => {
        const header = sframeHeader(f.head, f.kind === 'audio' ? 0 : f.type === 'key' ? 10 : 3);
        return header !== null && Number(header.kid % 16n) === (epoch + 1) % 16;
      }),
    ).toBe(true);
    expect(violations).toEqual([]);
    await spy.context.close();
    await close(owner, raj, bo);
  });

  test('browsers that cannot encrypt call media are refused, not downgraded', async ({
    browser,
  }) => {
    const { owner, members } = await groupOf(browser, 2);
    const [old] = members as [User];
    // A browser without WebRTC encoded-frame access (neither API).
    await old.page.addInitScript(() => {
      delete (window as unknown as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform;
      for (const endpoint of [RTCRtpSender.prototype, RTCRtpReceiver.prototype])
        delete (endpoint as unknown as { createEncodedStreams?: unknown }).createEncodedStreams;
    });
    await old.page.reload();
    await old.page.getByRole('button', { name: 'Video call' }).click();
    await expect(old.page.getByRole('alert')).toContainText(
      'This browser cannot end-to-end encrypt group calls',
    );
    // Nothing started on the server either.
    const calls = await database(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) FROM calls c JOIN users u ON u.id = c.initiator_user_id WHERE u.username = $1`,
        [old.username],
      );
      return Number(result.rows[0]?.count);
    });
    expect(calls).toBe(0);
    // A supported browser in the same group can call, and the old one still cannot join.
    await owner.page.getByRole('button', { name: 'Video call' }).click();
    await expectConnected(owner.page);
    await old.page.reload();
    await old.page
      .getByRole('region', { name: /^Standup/ })
      .getByRole('button', { name: 'Join call' })
      .click();
    await expect(old.page.getByRole('alert')).toContainText(
      'This browser cannot end-to-end encrypt group calls',
    );
    await close(owner, old);
  });
});
