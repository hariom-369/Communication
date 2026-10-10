# Notifications

Status: IMPLEMENTED in Phase 10 ([report](phase-reports/phase-10.md)) · Decision: **ADR-048**

## 0. As built (Phase 10)

- **Server** (`services/api/src/modules/notifications`): push subscriptions bound to a session and
  an encryption device; preferences (messages, calls, channel posts, quiet hours), muted
  conversations, security alerts; a Valkey coalescing queue drained by a singleton worker;
  Web Push through `web-push` (RFC 8291/8292) and the SSRF-hardened POST to allow-listed push
  services. Hooks: new message (not commits), call ringing, channel post, security notice.
- **Realtime gateway** marks sessions with an open connection (`presence:session:<id>`): they
  are not pushed.
- **Web**: Settings → Notifications (turn on for this browser, what notifications show, rules,
  quiet hours, muted chats); mute in a chat's details; "Notify me of new posts" on channels;
  security alerts on the Security page with a badge in the navigation. The service worker
  (`apps/web/src/sw/sw.ts`) decrypts on the device; an open page notifies while hidden.
- **One writer per device**: a Web Lock plus a writer fence in the local store (ADR-048); a
  second tab shows "Tessera is open in another tab — Use here".

Deviations (ADR-048): mentions do not bypass coalescing or mutes (the server cannot see them);
quiet hours are server-side (a silent push is not allowed by browsers). Not done: native push
(APNs/FCM apps), email digests, push in browsers other than Chromium verified by tests.

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

## 6. Tests (Phase 10)

| What | Where |
|---|---|
| Content-free, padded, encrypted, VAPID-signed pushes; per-subscription topic | `notifications.integration.test.ts` (decrypted with `http_ece`, signature checked), `push.test.ts` |
| Coalescing (burst → one push; later message delayed, not dropped) | `notifications.integration.test.ts` |
| Mutes, preferences, quiet hours (incl. across midnight / time zones), removed members | `notifications.integration.test.ts`, `push.test.ts`, `text.test.ts` |
| No push to connected or signed-out sessions; 410 cleanup; rotation keeps the subscription | `notifications.integration.test.ts`, realtime `gateway.integration.test.ts` |
| Endpoint allow-list and SSRF rules | `push.test.ts` (mutation-checked) |
| Push → service worker decrypts → notification; preview setting; delivered vs read | `e2e/notifications.spec.ts` (real API pushes to a stand-in push service; delivered to the service worker through DevTools) |
| One writer per device ("Use here") | `crypto/single-writer.test.ts`, `messaging/e2ee.test.ts`, `e2e/notifications.spec.ts` |
| Security alerts on every device | `notifications.integration.test.ts`, `e2e/notifications.spec.ts` |
