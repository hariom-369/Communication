# Phase 10 report — Notifications

**Status: GREEN locally; the exit criterion "push delivery tests across browsers" is met for
Chromium only** (see "Not met"). Verified 2026-10-10. CI has not run, because the branch still
cannot be pushed (GitHub returns 403 for the Claude app).

Devices are woken by **content-free** Web Push messages; the device fetches the end-to-end
encrypted message and decrypts it **itself**, in a service worker, then shows what this device's
setting allows. The server only decides *whether* to wake a device. Design and trade-offs:
**ADR-048** and [notifications.md](../notifications.md) §0.

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass |
| Unit tests | **542 TypeScript** (api 326, web 129, ui 59, platform 15, shared 7, realtime 3, validation 3) + **75 Rust** (crypto core unchanged) |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **150 passed** (api 134, realtime 16); 2 skipped (IPv6 TURN test without IPv6 here; opt-in channel scale test) |
| End-to-end (Chromium, production build, strict CSP + Trusted Types, real services) | **41 passed in each of 3 consecutive full runs** (4 new notification tests; axe audit extended); 1 skipped (opt-in call load test) |
| Mutation checks | notifications 11/11 caught (connected-session skip, session/device validity, mutes, quiet hours, membership, sender exclusion, per-subscription topic, padding, host allow-list suffix, device ownership, minimum interval); single writer 5/5 (writer fence, LOCKED after loss, `try` mode, busy → elsewhere, writer claim); unseen marker 1/1 |
| Accessibility (axe) | no violations on Settings → Notifications (with quiet hours open) and the Security page with alerts |
| OpenAPI | 143 paths (8 new; 11 new routes) |
| `pnpm audit --prod` / gitleaks (history and changed sources) | no known vulnerabilities / no leaks |

### Exit criteria

| Criterion | Evidence |
|---|---|
| No content leaves the server | The integration and E2E tests decrypt the real pushes the API sends (RFC 8291, with the subscription's private key) and verify the VAPID signature: the payload is exactly `{t, c, p}` padded to 128 bytes; the message text is in neither the payload, the encrypted body nor any header. |
| Push delivery tests | Chromium: real API → push service stand-in → service worker (DevTools `ServiceWorker.deliverPushMessage`) → decryption on the device → notification; preview settings; delivered vs read. **Firefox and Safari: not tested** (see "Not met"). |

## Delivered

- **API** (`modules/notifications`, migration `0011_notifications.sql`, 11 routes):
  - Push subscriptions bound to a session and an encryption device, checked before every push,
    kept across session rotation, removed on 404/410 or repeated failure, swept hourly.
  - Content-free payloads, padded; per-subscription topics; TTL and urgency per kind; VAPID.
  - Preferences (messages, calls, channel posts), quiet hours with time zone (may cross
    midnight; one-to-one calls may ring), muted conversations (until a time or unmuted).
  - A coalescing queue in Valkey (5 s window, 10 s minimum interval, delayed never dropped)
    drained by a singleton worker; channel fan-out in batches of 1,000 opted-in subscribers.
  - Hooks: new messages (not commits), ringing calls (immediate, high urgency), channel posts,
    and every security notice (stored, realtime hint, push, email).
  - SSRF-hardened POST with a push-service allow-list (`platform/safe-fetch/post.ts`).
- **Realtime gateway**: marks sessions with an open connection; they are not pushed.
- **Web**:
  - Service worker `/sw.js` (classic script, built separately) with the same encryption engine:
    decrypts new messages, then shows a notification (nothing / name / name and message — private
    by default), acknowledges delivery, records the messages as unseen; call, channel and alert
    notifications; notification click opens the conversation.
  - One writer per device: Web Lock + writer fence; a second tab shows "Tessera is open in another
    tab — Use here".
  - Settings → Notifications (turn on for this browser, what notifications show, rules, quiet
    hours, muted chats); mute in a chat's details; "Notify me of new posts" on channels; security
    alerts on the Security page with a navigation badge; notifications from the open page while it
    is hidden (same rules); on-device conversation titles for the service worker.

## Defects found and fixed during the phase

1. **Two tabs could fork a device's encryption state** (pre-existing since Phase 4): each tab ran
   its own crypto worker on the same stored MLS state. Now one context holds the device's Web Lock,
   and a writer fence in the local store stops a context that lost it from overwriting newer
   state.
2. **A privilege change would have orphaned the browser's push subscription**: step-up and
   password changes rotate the session, and subscriptions are bound to sessions. They now follow
   the rotation.
3. **Messages decrypted by the service worker looked read** in the app: the tab took the server's
   *delivered* marker as *read*. The service worker records what it notified about on the device;
   the app counts those as unread and sends read receipts when they are read (E2E-tested).
4. **A select wrapped in its label got the selected option in its accessible name**
   ("Notifications On"); the mute control now uses an explicit label (found by the E2E test).
5. **The preview default contradicted docs/privacy.md** (it showed sender and text); the default
   is now "Nothing" ("New message"), as designed.

## Not met / deferred (tracked)

- **Push in Firefox and Safari is not tested.** Only Chromium is installed here, and no test can
  reach the real push services (FCM, Mozilla autopush, Apple). The server side is standard
  (RFC 8030/8291/8292 via `web-push`) and the payload handling is browser-independent, but
  cross-browser delivery moves to Phase 14 (cross-browser PWA work). iOS delivers web push only
  to apps added to the home screen (the settings page says so).
- **Real push services** were not exercised; the stand-in implements the RFC 8030 receiving
  side and the browser step is driven through DevTools.
- Email change and account deletion alerts (those features do not exist yet); email digests;
  native push (APNs/FCM apps).
- Mentions cannot bypass coalescing or mutes (the server does not know who was mentioned) — a
  documented deviation from notifications.md §3.

## Security implications (threat-model delta)

- **Mitigated:** message content in notifications (none leaves the server — verified by
  decrypting real pushes); push services linking people through a conversation (per-subscription
  topics, fixed size); SSRF through push endpoints (allow-list, https:443, pinned public
  addresses, no redirects — mutation-tested); pushes to signed-out sessions, revoked devices or
  removed members (checked before every push); device-state corruption by two contexts (single
  writer — unit and E2E tested); notification floods (coalescing, minimum interval).
- **Residual:** push services see that and when a device is woken; the server knows preferences,
  mutes and quiet hours; what appears on a lock screen is the person's choice; untested browsers
  (above).
