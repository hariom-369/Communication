import { endpoints } from '../api/endpoints.js';
import { registerServiceWorker } from '../lib/worker-policy.js';

import { readDevicePrefs, writeDevicePrefs } from './device-prefs.js';

/**
 * Web Push on this browser (docs/notifications.md §1, §5): the service worker, the browser
 * permission, and the subscription the server knows for this session and device.
 */

export type PushSupport =
  | 'supported'
  /** The browser has no Push API (or no service workers). */
  | 'unsupported'
  /** iOS and iPadOS deliver web push only to apps added to the home screen. */
  | 'install-required';

export function pushSupport(): PushSupport {
  const hasApi =
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    typeof Notification !== 'undefined';
  if (hasApi) return 'supported';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone ? 'install-required' : 'unsupported';
}

function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The subscription in the shape the API expects. */
function toInput(subscription: PushSubscription, deviceId: string) {
  const json = subscription.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (json.endpoint === undefined || p256dh === undefined || auth === undefined)
    throw new Error('The browser returned an incomplete push subscription.');
  return { endpoint: json.endpoint, keys: { p256dh, auth }, deviceId };
}

async function subscribeHere(userId: string, deviceId: string, vapidKey: string): Promise<void> {
  const registration = await registerServiceWorker();
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription !== null) {
    const current = subscription.options.applicationServerKey;
    const wanted = applicationServerKey(vapidKey);
    const same =
      current !== null &&
      new Uint8Array(current).length === wanted.length &&
      new Uint8Array(current).every((byte, index) => byte === wanted[index]);
    if (!same) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(vapidKey),
  });
  await endpoints.subscribePush(toInput(subscription, deviceId));
  await writeDevicePrefs(userId, { deviceId, push: true });
}

/** Asks for permission (from a click) and registers this browser for pushes. */
export async function enablePush(userId: string, deviceId: string): Promise<void> {
  const config = await endpoints.notificationConfig();
  if (!config.pushAvailable || config.vapidPublicKey === null)
    throw new Error('Push notifications are not available on this server.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser’s site settings.'
        : 'Notifications were not allowed.',
    );
  await subscribeHere(userId, deviceId, config.vapidPublicKey);
}

/** Stops pushes to this browser (server first, so nothing more is sent). */
export async function disablePush(userId: string): Promise<void> {
  await writeDevicePrefs(userId, { push: false });
  await endpoints.unsubscribePush().catch(() => undefined);
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

/**
 * On start: when this browser already allowed notifications, make sure the server has this
 * session's subscription (new sign-in, rotated push endpoint, or a changed server key).
 */
export async function restorePush(userId: string, deviceId: string): Promise<boolean> {
  if (pushSupport() !== 'supported' || Notification.permission !== 'granted') return false;
  if (!(await readDevicePrefs(userId)).push) return false;
  const config = await endpoints.notificationConfig();
  if (!config.pushAvailable || config.vapidPublicKey === null) return false;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const existing = await registration?.pushManager.getSubscription();
  if (config.subscribed && existing !== undefined && existing !== null) return true;
  await subscribeHere(userId, deviceId, config.vapidPublicKey);
  return true;
}
