# Phase 8 report — Broadcast channels

**Status: GREEN locally.** Verified 2026-10-08. CI has not run, because the branch still
cannot be pushed (GitHub returns 403 for the Claude app).

Channels are one-to-many feeds: a handle, posts, polls, reactions, comments, scheduling, admin
roles and analytics. They are **not end-to-end encrypted** (ADR-012), and the UI says so wherever
channel content is read or written. Design and trade-offs: ADR-046 and
[channels.md](../channels.md) §0.

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass |
| Unit tests | **482 TypeScript** (api 298 including a 65-case SSRF suite, web 97, ui 59, platform 15, shared 7, realtime 3, validation 3) + **71 Rust** |
| Integration (real PostgreSQL + Valkey + S3-compatible store) | **130**: api 115, realtime 15 |
| Scale (exit criterion, `TESSERA_SCALE_TESTS=1`) | **1,000,000-subscriber publish**: median 9.4 ms vs 11.5 ms for one subscriber; **0 writes** to `channel_subscribers` per publish |
| End-to-end (Chromium, production build, strict CSP + Trusted Types, real services) | **31 passed in each of 3 consecutive full runs** (2 new channel tests; axe audit extended) |
| Accessibility (axe) | no violations on the channels directory, channel page with composer and poll, feed, settings and analytics |
| Mutation checks | SSRF fetcher 6/6 caught (multi-address check, redirect re-validation, mapped IPv6, link-local range, size cap, port rule); channel controls 7/7 caught (private visibility, publish compare-and-set, grant subset, ownership cool-down, slow mode, anonymous polls, reaction counting) |
| OpenAPI | 127 paths (24 new; 35 new routes) |
| `pnpm audit --prod` / gitleaks (history and changed sources) | no known vulnerabilities / no leaks |

## Delivered

- **SSRF-hardened fetcher** (`services/api/src/platform/safe-fetch`). It implements every rule of
  security.md §6:
  - https on port 443 only;
  - DNS resolved once, every answer checked against the deny-list, and the connection pinned to a
    checked address;
  - IPv4-mapped IPv6 refused; NAT64, 6to4 and Teredo handled;
  - redirects re-validated (at most 3);
  - 5 s deadline and 2 MiB cap; uncompressed HTML `<head>` only; fixed User-Agent; no cookies.

  Previews carry text only (title, description, site name). They are cached in Valkey, including
  failures.
- **Channels API** (`modules/channels`, migration `0009_channels.sql`, 35 routes):
  - Channels: create, view, edit, delete with re-authentication; directory search; handle lookup.
  - Subscriptions: subscribe and unsubscribe, with sharded counts; invite links for private
    channels.
  - Posts: publish now, schedule or save as a draft; edit, publish-now and removal. Link previews
    are fetched by the server.
  - Polls (anonymous or public), reactions from a fixed set, and comments with on/off and slow mode.
  - Full-text search within a channel.
  - Admins: a permission bitset; nobody grants more than they hold.
  - Ownership transfer: re-authentication, then a 24-hour cooling-off period during which the
    owner can cancel.
  - View counting with HyperLogLogs and a roll-up; aggregate analytics only.
  - A singleton scheduler that publishes each due post exactly once (`CHANNEL_SCHEDULER_INTERVAL_MS`).
  - Moderation of other people's content and every ownership step are audited.
- **Web:**
  - Channels directory and creation.
  - Channel page: subscribe, feed with older pages and polling, search, composer (link preview
    check, poll, schedule, draft), reactions, polls with voter lists, comments.
  - Drafts and scheduled tab; analytics tables; settings (info, comments, slow mode, admins,
    invite links, ownership, delete).
  - `/channel-invite/:token` page.

## Defects found and fixed during the phase

1. **The ownership hand-over list missed admins added moments earlier.** The settings sections
   each loaded their own admin list. They now share one.
2. **The scheduling minimum disagreed with its message** (the check allowed 10 s; the message said
   a minute). It is now 15 s in both, and the time picker accepts seconds.

## Not met / deferred (tracked)

- **Media in channel posts.** These need the public-media pipeline (malware scan, transcoding
  sandbox, CSAM hash matching), which is planned for Phase 11. The UI offers no upload, so there
  is no "coming soon".
- **Reports and takedown SLA timers** (the "takedown SLA timers" exit test in channels.md §7),
  synthetic-content labels and link reputation checks: Phase 11.
- **Subscriber notifications**: Phase 10. **Realtime "channel updated" hints**: open pages poll
  every 20 s instead.
- **Isolating the fetcher.** It runs in the API process. A separate service behind an egress proxy
  is required before the first shared environment (security.md §6).
- **"Private channel media not accessible without signed URL"** (channels.md §7) has nothing to
  test yet, because there is no channel media.
- Channel avatars; cross-channel search (OpenSearch).

## Security implications (threat-model delta)

- **Mitigated:**
  - Server-side request forgery to internal addresses, cloud metadata, other ports or schemes,
    redirect chains, DNS rebinding and oversized or compressed bodies (65 tests, 6 mutation checks).
  - Admins escalating their own or others' permissions.
  - Instant channel takeover from a stolen session.
  - Exposure of who viewed what.
  - Counter hot spots.
- **Residual:**
  - The fetcher shares a process with the API.
  - Public comments rely on rate limits, slow mode and admin moderation until Phase 11 reporting.
  - Channel content is server-readable by design (ADR-012).
