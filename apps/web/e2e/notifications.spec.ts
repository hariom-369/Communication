import { createECDH, randomBytes, type ECDH } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

import { PUSH_PORT } from './global-setup.js';
import { resetSignUpLimits, signUpWithPassword } from './support.js';

/**
 * Notifications end to end (docs/notifications.md, ADR-048): the real API sends real Web Push
 * requests (RFC 8291 encryption, RFC 8292 VAPID) to a stand-in push service here. The test
 * decrypts each push with the subscription's private key, as a browser would, checks that it
 * carries no content, and hands the payload to the browser's service worker through the DevTools
 * protocol — the step a push service and the browser would do. The service worker then decrypts
 * the message itself (the end-to-end encrypted ciphertext, with this device's keys).
 *
 * The browser's own PushManager.subscribe needs a real push service (FCM for Chromium), which a
 * test cannot use; it is replaced by one that returns a subscription to the stand-in service.
 */

const require = createRequire(import.meta.url);
const ece = require('http_ece') as {
  decrypt(
    buffer: Buffer,
    params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: string },
  ): Buffer;
};

const ORIGIN = 'http://localhost:4173';

interface ReceivedPush {
  readonly token: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}
const received: ReceivedPush[] = [];
let server: Server;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        token: (request.url ?? '').replace(/^\/push\//, ''),
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.statusCode = 201;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(PUSH_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

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

interface PushKeys {
  readonly token: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly ecdh: ECDH;
}

function pushKeys(): PushKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const token = randomBytes(12).toString('hex');
  return {
    token,
    endpoint: `http://127.0.0.1:${PUSH_PORT}/push/${token}`,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    ecdh,
  };
}

/** Stand-in for the browser's push service registration (see the file comment). */
async function fakePushManager(context: BrowserContext, keys: PushKeys): Promise<void> {
  await context.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      if (typeof PushManager === 'undefined') return;
      const bytes = (value: string) => {
        const padded = value.replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
      };
      // Per page, like a real subscription read back from the browser.
      let current: string | null = null;
      const make = (key: string) => ({
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: bytes(key) },
        getKey: (name: string) => bytes(name === 'p256dh' ? p256dh : auth),
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: () => {
          current = null;
          return Promise.resolve(true);
        },
      });
      PushManager.prototype.subscribe = function subscribe(options?: PushSubscriptionOptionsInit) {
        const raw = options?.applicationServerKey;
        const view =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : raw instanceof Uint8Array
              ? raw
              : new Uint8Array();
        const key = btoa(Array.from(view, (byte) => String.fromCharCode(byte)).join(''))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        current = key;
        return Promise.resolve(make(key) as unknown as PushSubscription);
      };
      PushManager.prototype.getSubscription = function getSubscription() {
        return Promise.resolve(
          current === null ? null : (make(current) as unknown as PushSubscription),
        );
      };
    },
    { endpoint: keys.endpoint, p256dh: keys.p256dh, auth: keys.auth },
  );
}

async function newUser(browser: Browser, push?: PushKeys) {
  await resetSignUpLimits();
  const context = await browser.newContext({ permissions: ['notifications'] });
  if (push !== undefined) await fakePushManager(context, push);
  const page = await context.newPage();
  const identity = await signUpWithPassword(page);
  await page.getByRole('link', { name: 'Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  return { page, context, ...identity };
}
type User = Awaited<ReturnType<typeof newUser>>;

const bubble = (page: Page, text: string | RegExp) =>
  page
    .getByRole('list', { name: /^Messages (in|with)/ })
    .getByRole('listitem')
    .filter({ hasText: text });

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.keyboard.press('Enter');
  await expect(bubble(page, text)).toContainText(/Sent|Delivered|Read/);
}

/** Alice and Bob in an end-to-end encrypted chat; returns the conversation id. */
async function pair(alice: User, bob: User): Promise<string> {
  await alice.page.getByLabel('Start a chat').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Start' }).click();
  await send(alice.page, 'hello bob');
  await bob.page.getByRole('link', { name: new RegExp(alice.username) }).click();
  await expect(bubble(bob.page, 'hello bob')).toBeVisible();
  const id = /\/chats\/([0-9a-f-]{36})/.exec(bob.page.url())?.[1];
  if (id === undefined) throw new Error('no conversation id in the URL');
  return id;
}

async function turnOnNotifications(user: User, show?: 'full' | 'name'): Promise<void> {
  await user.page.getByRole('link', { name: 'Notifications' }).click();
  // Private by default: notifications say only "New message" unless chosen otherwise.
  await expect(user.page.getByLabel('Notifications show')).toHaveValue('none');
  if (show !== undefined) await user.page.getByLabel('Notifications show').selectOption(show);
  await user.page.getByRole('button', { name: 'Turn on notifications' }).click();
  await expect(user.page.getByText('Notifications are on for this browser.')).toBeVisible();
}

async function pushesFor(keys: PushKeys, count: number, timeout = 30_000): Promise<ReceivedPush[]> {
  await expect
    .poll(() => received.filter((push) => push.token === keys.token).length, { timeout })
    .toBeGreaterThanOrEqual(count);
  return received.filter((push) => push.token === keys.token);
}

function decrypt(push: ReceivedPush, keys: PushKeys): string {
  return ece
    .decrypt(push.body, { version: 'aes128gcm', privateKey: keys.ecdh, authSecret: keys.auth })
    .toString('utf8');
}

/** A same-origin page that does not run the app (so no tab holds the encryption engine). */
async function helperPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/favicon.svg`);
  return page;
}

/** What the browser does when a push arrives: the service worker gets the decrypted payload. */
async function deliver(context: BrowserContext, helper: Page, payload: string): Promise<void> {
  const cdp = await context.newCDPSession(helper);
  const registrations: { registrationId: string; scopeURL: string }[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => {
    registrations.push(...event.registrations);
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => registrations.some((r) => r.scopeURL === `${ORIGIN}/`)).toBe(true);
  const registration = registrations.find((r) => r.scopeURL === `${ORIGIN}/`);
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: ORIGIN,
    registrationId: registration?.registrationId ?? '',
    data: payload,
  });
  await cdp.detach();
}

function notifications(helper: Page): Promise<{ title: string; body: string; tag: string }[]> {
  return helper.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const shown = (await registration?.getNotifications()) ?? [];
    return shown.map((n) => ({ title: n.title, body: n.body, tag: n.tag }));
  });
}

test.describe('notifications', () => {
  test('a closed app is woken by a content-free push; the device decrypts and shows the message', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const keys = pushKeys();
    const alice = await newUser(browser);
    const bob = await newUser(browser, keys);
    const conversationId = await pair(alice, bob);
    await turnOnNotifications(bob, 'full');
    const rows = await database((client) =>
      client.query<{ session_id: string; endpoint: string }>(
        `SELECT p.session_id, p.endpoint FROM push_subscriptions p JOIN users u ON u.id = p.user_id
         WHERE u.username = $1`,
        [bob.username],
      ),
    );
    expect(rows.rows).toEqual([expect.objectContaining({ endpoint: keys.endpoint })]);

    // Bob closes Tessera. Alice writes.
    await bob.page.close();
    const secret = 'meet me at the old library at nine';
    await send(alice.page, secret);

    const [push] = await pushesFor(keys, 1);
    if (push === undefined) throw new Error('no push');
    const payload = decrypt(push, keys);
    expect(Buffer.byteLength(payload)).toBe(128);
    expect(JSON.parse(payload)).toMatchObject({ t: 'sync', c: conversationId });
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(['c', 'p', 't']);
    // Neither the push service nor anyone on the way sees the message.
    for (const part of [payload, push.body.toString('latin1'), JSON.stringify(push.headers)])
      expect(part).not.toContain('library');
    expect(push.headers['authorization']).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(push.headers['content-encoding']).toBe('aes128gcm');

    // The browser hands it to the service worker, which decrypts the message on the device.
    const helper = await helperPage(bob.context);
    await deliver(bob.context, helper, payload);
    await expect
      .poll(() => notifications(helper), { timeout: 30_000 })
      .toContainEqual({ title: `@${alice.username}`, body: secret, tag: `chat:${conversationId}` });
    // Delivered to Bob's device (the service worker acknowledged it).
    await expect(bubble(alice.page, secret)).toContainText('Delivered', { timeout: 15_000 });

    // Bob opens Tessera: the message decrypted by the service worker is in the chat.
    const reopened = await bob.context.newPage();
    await reopened.goto(`${ORIGIN}/chats/${conversationId}`);
    await expect(bubble(reopened, secret)).toBeVisible();
    await expect(bubble(alice.page, secret)).toContainText('Read', { timeout: 15_000 });

    // "Notifications show: Nothing": the next notification only says that something is new.
    await reopened.getByRole('link', { name: 'Notifications' }).click();
    await reopened.getByLabel('Notifications show').selectOption('none');
    await reopened.close();
    await send(alice.page, 'second secret');
    const pushes = await pushesFor(keys, 2);
    const second = pushes[1];
    if (second === undefined) throw new Error('no second push');
    await deliver(bob.context, helper, decrypt(second, keys));
    await expect
      .poll(() => notifications(helper), { timeout: 30_000 })
      .toContainEqual({ title: 'Tessera', body: 'New message', tag: `chat:${conversationId}` });
    expect(JSON.stringify(await notifications(helper))).not.toContain('second secret');

    await alice.context.close();
    await bob.context.close();
  });

  test('muted chats and the open app are not woken', async ({ browser }) => {
    test.setTimeout(120_000);
    const keys = pushKeys();
    const alice = await newUser(browser);
    const bob = await newUser(browser, keys);
    await pair(alice, bob);
    await turnOnNotifications(bob);

    // Bob has Tessera open: realtime delivers, no push.
    await bob.page.getByRole('link', { name: 'Chats' }).click();
    await bob.page.getByRole('link', { name: new RegExp(alice.username) }).click();
    await send(alice.page, 'while you are here');
    await expect(bubble(bob.page, 'while you are here')).toBeVisible();

    // Bob mutes the chat and closes Tessera: still no push.
    await bob.page.getByRole('button', { name: 'Details' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Details', level: 2 })).toBeVisible();
    await bob.page.getByLabel('Notifications', { exact: true }).selectOption('always');
    await expect(bob.page.getByLabel('Notifications', { exact: true })).toHaveValue('always');
    await bob.page.close();
    await send(alice.page, 'while muted');
    await alice.page.waitForTimeout(9000); // past the 5-second coalescing window
    expect(received.filter((push) => push.token === keys.token)).toEqual([]);

    await alice.context.close();
    await bob.context.close();
  });

  test('one tab at a time uses encrypted chats; "Use here" takes over', async ({ browser }) => {
    const alice = await newUser(browser);
    const bob = await newUser(browser);
    await pair(alice, bob);
    const second = await bob.context.newPage();
    await second.goto(`${ORIGIN}/chats`);
    await expect(
      second.getByRole('heading', { name: 'Tessera is open in another tab' }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await second.getByRole('button', { name: 'Use here' }).click();
    await expect(
      bob.page.getByRole('heading', { name: 'Tessera is open in another tab' }),
    ).toBeVisible();
    await second.getByRole('link', { name: new RegExp(alice.username) }).click();
    await send(alice.page, 'to the new tab');
    await expect(bubble(second, 'to the new tab')).toBeVisible();
    await send(second, 'reply from the new tab');
    await expect(bubble(alice.page, 'reply from the new tab')).toBeVisible();
    await alice.context.close();
    await bob.context.close();
  });

  test('security alerts reach the app on every device', async ({ browser }) => {
    const bob = await newUser(browser);
    // Two sign-ins: the second, from a browser the account has not used, raises an alert.
    for (const userAgent of [
      undefined,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
    ]) {
      const other = await browser.newContext(userAgent === undefined ? {} : { userAgent });
      const page = await other.newPage();
      await page.goto('/login');
      await page.getByLabel('Email or username').fill(bob.email);
      await page.getByLabel('Password').fill(bob.password);
      await page.getByRole('button', { name: 'Sign in with password' }).click();
      await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
      await other.close();
    }
    await expect(bob.page.getByRole('link', { name: /Security/ })).toContainText('1');
    await bob.page.getByRole('link', { name: /Security/ }).click();
    const alerts = bob.page.getByRole('list', { name: 'Security alerts' });
    await expect(alerts.getByRole('listitem').first()).toContainText('New sign-in to your account');
    await expect(alerts.getByRole('listitem').first()).toContainText('New');
    await bob.page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(bob.page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
    await bob.context.close();
  });
});
