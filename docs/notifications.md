# Notifications

Status: PROPOSED

## 1. Channels

| Channel | Used for | Content |
|---|---|---|
| Web Push (RFC 8030 + 8291 encryption + VAPID 8292) | messages, calls, mentions, channel posts | **content-free** for E2EE: `{t:"sync", c:<opaque conv hint>}` |
| Email (SES/Postmark) | verification, security alerts, login alerts, device changes, billing, account deletion | no message content ever |
| In-app (realtime) | everything while connected | full, rendered from local decrypted data |
| Native push (APNs/FCM) — future | same as web push | content-free + Notification Service Extension decrypts on device |

## 2. E2EE-safe message notification flow

```
new mailbox message → outbox → notification worker
  → for each recipient device without an active realtime connection and with a push subscription:
      respect mute/DND/notification prefs (server-known)
      send push {type:"sync"} (TTL 1 h, urgency high for calls, normal for messages)
Service worker wakes → fetches new ciphertext → decrypts in crypto worker (WASM in SW context)
  → shows notification according to the *user's on-device preference*:
      "New message" | "Asha" | "Asha: preview…"
```

Limitations: browsers require a visible notification for each push (no silent push on
Chrome/Safari); if decryption in the service worker fails or times out, show generic
"New message". iOS Safari web push requires the PWA to be installed to the home screen.

Push services (Google, Mozilla, Apple) see: that a push was sent to an endpoint, time,
size. Payload is encrypted to the browser (RFC 8291) and contains no content anyway.

## 3. Coalescing and limits

Collapse multiple messages per conversation within 5 s; max 1 push per conversation per
10 s unless mention/call; group-level mute; quiet hours (client-configured, synced).

## 4. Security alerts (cannot be disabled)

New login, new device linked, password/email/MFA change, recovery started, backup key
changed, ASK rotated, account deletion scheduled. Sent by email and in-app to all devices.

## 5. Subscription hygiene

Push subscriptions bound to device; deleted on device revoke/logout; endpoints returning
404/410 removed; VAPID key rotation plan (re-subscribe flow).
