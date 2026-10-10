/// <reference lib="webworker" />
import init, {
  CryptoClient,
  MediaDecryptor,
  MediaEncryptor,
  parseLinkCode,
  verifyLinkCode,
} from '@tessera/crypto-core';
import wasmUrl from '@tessera/crypto-core/wasm?url';
import { pushPayloadSchema, type Conversation, type PushPayload } from '@tessera/validation';

import { endpoints } from '../api/endpoints.js';
import { CryptoEngine } from '../crypto/engine.js';
import { LocalStore } from '../crypto/local-store.js';
import { contentSchema } from '../messaging/content.js';
import { addUnseen, readDevicePrefs, type PreviewLevel } from '../notifications/device-prefs.js';
import { describeBody, messageNotification, type IncomingItem } from '../notifications/text.js';

/**
 * Service worker: push notifications only (docs/notifications.md §2, ADR-048). No fetch handler
 * and no caching — pages load from the network as before.
 *
 * A push says only "something new in conversation X". This worker fetches the ciphertext and
 * decrypts it here, on the device, with the same encryption engine as the app — but only when no
 * tab is using it (the device's Web Lock; a tab that is open shows its own notifications). What
 * the notification shows follows this device's setting (sender and text, conversation only, or
 * nothing). When anything fails, it shows a generic notification: browsers require one per push.
 */

declare const self: ServiceWorkerGlobalScope;

const MAX_PAGES = 5;

const core = { CryptoClient, MediaEncryptor, MediaDecryptor, parseLinkCode, verifyLinkCode };
let wasm: Promise<unknown> | null = null;

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

interface Shown {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
  readonly call?: boolean;
}

const GENERIC: Shown = { title: 'Tessera', body: 'New message', tag: 'tessera', url: '/chats' };

async function show(shown: Shown): Promise<void> {
  await self.registration.showNotification(shown.title, {
    body: shown.body,
    tag: shown.tag,
    icon: '/favicon.svg',
    data: { url: shown.url },
    requireInteraction: shown.call === true,
  });
}

function parse(data: PushMessageData | null): PushPayload | null {
  try {
    const result = pushPayloadSchema.safeParse(data?.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Conversation titles saved by the app; reading them changes nothing, so no lock is needed. */
async function readLabels(userId: string): Promise<Record<string, string>> {
  try {
    const store = await LocalStore.open(userId);
    try {
      return await store.labels();
    } finally {
      store.close();
    }
  } catch {
    return {};
  }
}

function titleOf(meta: Conversation, me: string, labels: Record<string, string>): string {
  const label = labels[meta.id];
  if (label !== undefined && label !== '') return label;
  const others = meta.members.filter((member) => member.userId !== me);
  if (meta.kind === 'group') return 'Group chat';
  return others[0] === undefined ? 'Tessera' : `@${others[0].username}`;
}

/** Decrypts new messages of one conversation, if no tab is using the encryption engine. */
async function syncConversation(conversationId: string): Promise<Shown> {
  const me = await endpoints.me();
  const prefs = await readDevicePrefs(me.id);
  const meta = await endpoints.conversation(conversationId);
  const fallback = (level: PreviewLevel, labels: Record<string, string>): Shown => ({
    title: level === 'none' ? 'Tessera' : titleOf(meta, me.id, labels),
    body: 'New message',
    tag: `chat:${conversationId}`,
    url: `/chats/${conversationId}`,
  });
  wasm ??= init({ module_or_path: wasmUrl });
  await wasm;
  const engine = new CryptoEngine(core);
  const lock = await engine.call('acquire', [me.id, 'try']);
  // A tab is open (it shows its own notifications for what it receives).
  if (lock === 'busy') return fallback(prefs.preview, await readLabels(me.id));
  try {
    const { identity } = await engine.call('init', [me.id]);
    const labels = await engine.call('labels', []);
    if (identity === null || identity.pending) return fallback(prefs.preview, labels);
    const peers = meta.members.map((member) => member.userId).filter((id) => id !== me.id);
    const names = new Map(meta.members.map((member) => [member.userId, member.username]));
    const items: IncomingItem[] = [];
    let firstShown: number | null = null;
    let cursor = await engine.call('cursor', [conversationId]);
    let processed = cursor;
    pages: for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await endpoints.messages(conversationId, { after: cursor, limit: 100 });
      for (const message of result.messages) {
        const outcome = await engine.call('ingest', [
          conversationId,
          {
            seq: message.seq,
            kind: message.kind,
            senderUserId: message.senderUserId,
            senderDeviceId: message.senderDeviceId,
            serverTime: message.serverTime,
            clientMessageId: message.clientMessageId,
            ciphertext: message.ciphertext,
            commitment: message.commitment,
            frankingTag: message.frankingTag,
          },
          peers,
        ]);
        // Not joined yet (a Welcome is waiting): the app finishes this when it next opens.
        if (outcome.status === 'no-group') break pages;
        processed = message.seq;
        if (outcome.status !== 'application' || outcome.record.senderUserId === me.id) continue;
        const content = contentSchema.safeParse(JSON.parse(outcome.record.content ?? 'null'));
        if (!content.success) continue;
        const text = describeBody(content.data.body);
        if (text === null) continue;
        const body = content.data.body;
        firstShown ??= message.seq;
        items.push({
          sender: `@${names.get(outcome.record.senderUserId) ?? 'someone'}`,
          text,
          mentionsMe: body.kind === 'text' && (body.mentions ?? []).includes(me.id),
        });
      }
      cursor = result.messages.at(-1)?.seq ?? cursor;
      if (!result.hasMore) break;
    }
    // Delivered to this device (read receipts are separate and still need the person).
    if (processed > 0) await endpoints.ack(conversationId, processed).catch(() => undefined);
    if (items.length === 0) return fallback(prefs.preview, labels);
    // Delivered, but not seen: the app counts these as unread when it next opens.
    if (firstShown !== null) await addUnseen(me.id, conversationId, firstShown);
    const text = messageNotification({
      conversationTitle: titleOf(meta, me.id, labels),
      isGroup: meta.kind === 'group',
      items,
      level: prefs.preview,
    });
    return { ...text, tag: `chat:${conversationId}`, url: `/chats/${conversationId}` };
  } finally {
    engine.releaseLock();
  }
}

async function callNotification(conversationId: string, callId: string): Promise<Shown> {
  const me = await endpoints.me();
  const prefs = await readDevicePrefs(me.id);
  const meta = await endpoints.conversation(conversationId);
  const labels = await readLabels(me.id);
  return {
    title: 'Incoming call',
    body: prefs.preview === 'none' ? 'Tessera' : titleOf(meta, me.id, labels),
    tag: `call:${callId}`,
    url: `/chats/${conversationId}`,
    call: true,
  };
}

async function channelNotification(channelId: string): Promise<Shown> {
  const me = await endpoints.me();
  const prefs = await readDevicePrefs(me.id);
  const channel = await endpoints.channel(channelId);
  const latest = (await endpoints.channelPosts(channelId, { limit: 1 })).posts[0];
  const body =
    prefs.preview === 'full' && latest !== undefined && latest.body !== ''
      ? latest.body.replace(/\s+/g, ' ').slice(0, 160)
      : 'New post';
  return {
    title: prefs.preview === 'none' ? 'Tessera' : channel.title,
    body,
    tag: `channel:${channelId}`,
    url: `/channels/${channelId}`,
  };
}

async function alertNotification(): Promise<Shown> {
  const { alerts } = await endpoints.securityAlerts();
  const latest = alerts.find((alert) => !alert.read) ?? alerts[0];
  return {
    title: 'Security alert',
    body: latest?.headline ?? 'Check your account’s security alerts.',
    tag: 'security',
    url: '/settings/security',
  };
}

async function handle(payload: PushPayload | null): Promise<void> {
  let shown: Shown = GENERIC;
  try {
    if (payload?.t === 'sync') shown = await syncConversation(payload.c);
    else if (payload?.t === 'call') shown = await callNotification(payload.c, payload.k);
    else if (payload?.t === 'channel') shown = await channelNotification(payload.c);
    else if (payload?.t === 'alert') shown = await alertNotification();
  } catch {
    if (payload?.t === 'sync') shown = { ...GENERIC, tag: `chat:${payload.c}` };
  }
  await show(shown);
}

self.addEventListener('push', (event) => {
  event.waitUntil(handle(parse(event.data)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const path = typeof data?.url === 'string' && data.url.startsWith('/') ? data.url : '/chats';
  event.waitUntil(
    (async () => {
      const url = new URL(path, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open !== undefined) {
        await open.focus();
        await open.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/** The push service replaced this browser's subscription: register the new one. */
self.addEventListener('pushsubscriptionchange', (event) => {
  const change = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
    waitUntil(promise: Promise<unknown>): void;
  };
  change.waitUntil(
    (async () => {
      const me = await endpoints.me();
      const prefs = await readDevicePrefs(me.id);
      if (!prefs.push || prefs.deviceId === null) return;
      const key = change.oldSubscription?.options.applicationServerKey ?? null;
      const subscription =
        change.newSubscription ??
        (key === null
          ? null
          : await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            }));
      const json = subscription?.toJSON();
      const p256dh = json?.keys?.['p256dh'];
      const auth = json?.keys?.['auth'];
      if (json?.endpoint === undefined || p256dh === undefined || auth === undefined) return;
      await endpoints.subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh, auth },
        deviceId: prefs.deviceId,
      });
    })().catch(() => undefined),
  );
});
