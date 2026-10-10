import type { NotificationPreferences } from '@tessera/validation';

import { endpoints } from '../api/endpoints.js';
import type { E2eeSession } from '../messaging/e2ee.js';
import type { MessagingStore } from '../messaging/store.js';
import { conversationTitle } from '../pages/chats/titles.js';

import { readDevicePrefs, type PreviewLevel } from './device-prefs.js';
import { restorePush } from './push.js';
import { describeBody, inQuietHours, messageNotification } from './text.js';

/**
 * Connects an open page to notifications (docs/notifications.md §2):
 * - the server does not push to a connected session, so while this page is hidden it shows
 *   notifications itself, from messages it decrypted, under the same rules as the server (mutes,
 *   preferences, quiet hours) and this device's preview setting;
 * - it keeps the on-device titles current for the service worker;
 * - it re-registers this browser's push subscription when push was turned on here.
 */

/** Older messages arrive during catch-up; the service worker already notified about them. */
const LIVE_MS = 120_000;
const LABELS_DELAY_MS = 1500;

export function startNotificationBridge(options: {
  readonly store: MessagingStore;
  readonly e2ee: E2eeSession;
  readonly userId: string;
}): () => void {
  const { store, e2ee, userId } = options;
  let mutes = new Map<string, number | null>();
  let preferences: NotificationPreferences | null = null;
  let pushOn = false;
  let preview: PreviewLevel = 'none';
  let disposed = false;

  const refresh = async () => {
    const [mutesResult, preferencesResult, device] = await Promise.all([
      endpoints.mutes(),
      endpoints.notificationPreferences(),
      readDevicePrefs(userId),
    ]);
    if (disposed) return;
    mutes = new Map(
      mutesResult.mutes.map((mute) => [
        mute.conversationId,
        mute.until === null ? null : Date.parse(mute.until),
      ]),
    );
    preferences = preferencesResult;
    pushOn = device.push;
    preview = device.preview;
  };
  const refreshQuietly = () => {
    refresh().catch(() => undefined);
  };
  refreshQuietly();
  const offSettings = store.onNotificationsChanged((what) => {
    if (what === 'settings') refreshQuietly();
  });
  window.addEventListener('focus', refreshQuietly);

  let restored = false;
  const offSecurity = e2ee.subscribe(() => {
    const deviceId = e2ee.deviceId;
    if (restored || e2ee.status !== 'ready' || deviceId === null) return;
    restored = true;
    restorePush(userId, deviceId).catch(() => undefined);
  });

  let lastLabels = '';
  let labelTimer: ReturnType<typeof setTimeout> | null = null;
  const offStore = store.subscribe(() => {
    if (labelTimer !== null) clearTimeout(labelTimer);
    labelTimer = setTimeout(() => {
      const snapshot = store.getSnapshot();
      const labels = Object.fromEntries(
        snapshot.conversations.map((c) => [
          c.meta.id,
          conversationTitle(c, userId, snapshot.spaces[c.meta.id]),
        ]),
      );
      const json = JSON.stringify(labels);
      if (json === lastLabels) return;
      lastLabels = json;
      e2ee.setLabels(labels).catch(() => {
        lastLabels = '';
      });
    }, LABELS_DELAY_MS);
  });

  const muted = (conversationId: string) => {
    if (!mutes.has(conversationId)) return false;
    const until = mutes.get(conversationId);
    return until === null || until === undefined || until > Date.now();
  };

  const offIncoming = store.onIncoming((event) => {
    if (document.visibilityState !== 'hidden' || !pushOn) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (Date.now() - event.serverTime > LIVE_MS) return;
    if (preferences !== null && !preferences.messages) return;
    if (inQuietHours(preferences?.quietHours ?? null) || muted(event.conversationId)) return;
    const text = describeBody(event.body);
    if (text === null) return;
    const snapshot = store.getSnapshot();
    const conversation = snapshot.conversations.find((c) => c.meta.id === event.conversationId);
    if (conversation === undefined) return;
    const sender = conversation.meta.members.find((m) => m.userId === event.senderUserId);
    const shown = messageNotification({
      conversationTitle: conversationTitle(
        conversation,
        userId,
        snapshot.spaces[event.conversationId],
      ),
      isGroup: conversation.meta.kind === 'group',
      items: [
        {
          sender: `@${sender?.username ?? 'someone'}`,
          text,
          mentionsMe: event.body.kind === 'text' && (event.body.mentions ?? []).includes(userId),
        },
      ],
      level: preview,
    });
    void showFromPage(
      shown.title,
      shown.body,
      `chat:${event.conversationId}`,
      `/chats/${event.conversationId}`,
    );
  });

  return () => {
    disposed = true;
    offSettings();
    offSecurity();
    offStore();
    offIncoming();
    window.removeEventListener('focus', refreshQuietly);
    if (labelTimer !== null) clearTimeout(labelTimer);
  };
}

async function showFromPage(title: string, body: string, tag: string, url: string): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (registration !== undefined) {
      await registration.showNotification(title, {
        body,
        tag,
        icon: '/favicon.svg',
        data: { url },
      });
      return;
    }
    new Notification(title, { body, tag, icon: '/favicon.svg' });
  } catch {
    // Notifications are a convenience; the message is in the chat either way.
  }
}
