# Phase 3 report — Core messaging and realtime

**Status: GREEN** (locally verified 2026-09-28; CI has not run because the branch still cannot be
pushed — GitHub returns 403 for the Claude app).

Chat works end to end, but only in **development builds**, and it is **not end-to-end
encrypted** yet: the Phase 3 codec is a development plaintext codec, gated so that it cannot
reach staging or production (ADR-038). E2EE arrives in Phase 4.

## Results

| Gate | Result |
|---|---|
| Format, lint (typed, strict, security rules), typecheck, build | pass |
| Unit tests | **236 passed**: api 119, ui 59, web 30, platform 15, shared 7, realtime 3, validation 3 |
| Integration tests (real PostgreSQL + Valkey) | **83 passed**: api 68, realtime 15; two consecutive runs clean |
| End-to-end (Chromium, real API + realtime + DB + Valkey + SMTP, strict CSP) | **15 passed**, two consecutive full runs without flakes |
| Accessibility | axe clean on the chat list and an open conversation (desktop and 360 px); no horizontal scroll at 360 px |
| Mutation checks of new security controls | 7 of 7 caught (listed below) |
| Production bundle check (`verify:bundle`) | no development messaging code in the default build |
| OpenAPI | 37 paths (9 new), regenerated |
| `pnpm audit` / gitleaks | no known vulnerabilities / no leaks |

## Delivered

**API (`services/api`)**
- `messaging` module and migration `0003_messaging.sql`:
  - tables `conversations`, `conversation_members`, `direct_pairs`;
  - `mailbox_messages`, hash-partitioned 16 ways, with a unique idempotency index and an expiry
    index.
- Endpoints:
  - open a direct conversation (idempotent; resolves simultaneous first contact to one
    conversation);
  - list conversations (activity order, cursor pagination);
  - get one conversation;
  - send;
  - list messages (`after` / `before`);
  - ack;
  - sync;
  - set the disappearing-message timer.
- Send transaction:
  - membership check;
  - idempotency on `(conversation, sender, clientMessageId)`;
  - epoch check;
  - gap-free `seq` under `FOR UPDATE`;
  - ciphertext stored as `bytea` and never parsed.
- Realtime events are published after commit.
- Mailbox sweeper runs as a singleton (advisory lock) every 5 minutes. It deletes rows that are
  expired (disappearing timer or the 30-day retention limit) or that every member has already
  acked.
- `realtime` module:
  - single-use WebSocket tickets (256-bit, 30 s, bound to the session);
  - presence with privacy enforcement at read time and reciprocity;
  - revoking a session publishes `sessions_changed` so open sockets are re-checked.
- Config: `MESSAGING_DEV_PLAINTEXT`, which production validation rejects; ciphersuite `0` is
  refused unless it is set.
- Robustness: idle PostgreSQL pool errors (restart, failover) are now logged instead of crashing
  the process (API, migrate job, realtime).

**Realtime (`services/realtime`, new)**
- Connection handling:
  - Origin allow-list checked before the upgrade (CSWSH);
  - `tessera.v1` subprotocol;
  - ticket authentication in the first frame (5 s timeout);
  - session re-checked every 60 s and on revocation.
- Traffic and delivery:
  - per-user Valkey fan-out across pods (ADR-037);
  - typing relayed to members only (membership cache);
  - JSON frames validated with Zod (ADR-036).
- Limits:
  - 10 sockets per user;
  - frame token bucket (20/s, burst 40);
  - 4 KiB client frames;
  - backpressure close at 1 MiB buffered.
- Liveness and presence:
  - heartbeat with termination of dead peers;
  - presence (online, last seen).
- On deploy it sends jittered `reconnect` hints, then drains.
- Health endpoints on a separate port.

**Web (`apps/web`)**
- Messaging store:
  - outbox with full-jitter retries, the same client id on every retry, and FAILED on
    permanent errors or after 24 h;
  - ordered catch-up with gap filling;
  - coalesced acks;
  - read markers only when the user shares read receipts.
- Timeline reducer, pure and unit-tested, enforcing:
  - reactions, one per member;
  - edits by the sender within 15 min;
  - delete for everyone within 48 h;
  - read markers that only move forward;
  - protection against id collisions.
- Realtime client:
  - ticket, then auth frame;
  - backoff reconnects between 0.5 s and 30 s;
  - honours `reconnect` hints;
  - drops the socket as soon as the browser reports it is offline.
- Chat UI:
  - conversation list with unread badges and previews;
  - start a chat by username;
  - timeline showing delivery state (sending, waiting for connection, sent, delivered, read,
    failed with retry), reply, reactions, edit, delete, typing indicator and presence;
  - details panel with the disappearing-message timer;
  - responsive layout: panes side by side on desktop, one pane at a time on phones.
- Message text is always rendered as text. The E2E test sends an HTML/script payload and checks
  that it stays inert.
- Chat routes, navigation and the codec exist **only** in `build:dev-messaging`. That build shows
  a permanent "not end-to-end encrypted" banner. The default production build contains none of
  it, and CI checks this.

## Defects found and fixed during this phase

1. **The development codec leaked into the production bundle.** Bracket access
   (`import.meta.env['…']`) is not statically replaced by Vite, so the flag was evaluated at
   runtime and the codec was bundled. `verify:bundle` caught it. Fixed with dot access and a
   typed env declaration. The bundle check now runs in CI.
2. **Going offline was not noticed.** A browser that loses connectivity can leave a WebSocket
   half-open for minutes, so the app kept showing "Connected" and new messages looked sent. The
   client now drops the socket on the `offline` event and shows the offline state immediately.
   Covered by a unit test and E2E.
3. **Horizontal scroll on phones.** The shell grid column grew to fit the nav's min-content width
   (405 px on a 360 px screen). Fixed with `minmax(0, 1fr)` columns and a wrapping nav. The E2E
   audit now asserts there is no horizontal overflow at 360 px.
4. **The composer did not stay at the bottom of the screen.** Grid rows assumed optional elements
   were present. Fixed with a flex column and a fixed shell row. Asserted in E2E.
5. **No `<h1>` on phones with a conversation open** (axe `page-has-heading-one`). Added a
   phone-only, visually hidden heading.
6. **An unhandled idle-connection error from the pg pool** would crash the process on database
   failover. It surfaced as an unhandled error in the integration run. Fixed in all services.
7. **React compiler findings**: `setState` in effects, impure `Date.now()` during render, and ref
   reads during render. All restructured (`useNow`, keyed remounts, store-held settings).

## Mutation checks (each control disabled; a test must fail)

1. Ticket single use.
2. Origin check.
3. Revoked-session ticket.
4. Typing membership.
5. History authorization (non-member reads).
6. `seq` ordering lock.
7. Send idempotency.

Every mutation was caught. The Phase 2 checks are listed in the Phase 2 report.

## Security implications reviewed

New attack surface:
- 9 API endpoints;
- 1 WebSocket endpoint;
- a Valkey pub/sub bus.

Threat-model entries addressed:
- **T-14 CSWSH:** Origin allow-list before the upgrade, plus ticket-only authentication. The
  cookie that now also reaches `/rt/*` is ignored.
- **T-24 replay:** tickets are single use (`GETDEL`).
- **Authorization:** every read and write checks membership. Non-members and unknown
  conversations get identical 404s, so neither can be enumerated.
- **Abuse:** per-user send and open limits (opening fails closed), frame limits, connection
  limits and backpressure.
- **Session revocation** reaches open sockets.
- **XSS:** message text is only ever rendered as text, and CSP stays unchanged
  (`connect-src 'self'`).

Metadata the server can see, documented in [realtime.md](../realtime.md) and
[messaging.md](../messaging.md):
- membership and message timing and size;
- delivery acks;
- typing events;
- presence, subject to privacy settings.

**Plaintext:**
- Production builds and the production config cannot carry any.
- A schema test asserts that the only payload column is `bytea` and that no text or JSON column
  can hold content.
- Logs contain no payloads, which the existing log allow-list test covers.

Residual risks and open items:
- Until Phase 4, development builds send **readable content** to the server. This is acceptable
  only on local and test machines. ADR-038 plus the CI bundle check prevent it reaching
  deployment.
- There is no per-IP cap on unauthenticated sockets yet. The 5 s auth timeout bounds them. An
  edge limit is required before launch (Phase 15/17).
- Fan-out is fire-and-forget pub/sub. A missed event is recovered by `sync` on reconnect or when
  a gap is detected, not immediately (ADR-037).
- The outbox is in memory, so unsent messages are lost if the tab closes. The persisted,
  encrypted outbox comes with the encrypted local store (Phase 4).
- Reconnect-storm load testing has moved to Phase 15.

## Decisions

- **ADR-033 amended:** realtime is served at `/rt/*` on the web origin.
- **ADR-036:** JSON frames; sends over REST.
- **ADR-037:** per-user fan-out until devices exist.
- **ADR-038:** development plaintext codec with three gates.

## Next

**Phase 4, E2EE foundation:**
- crypto core (OpenMLS in Rust compiled to WASM, running in a worker);
- account and device keys;
- KeyPackages;
- 1:1 MLS groups replacing the development codec;
- safety numbers;
- the encrypted local store.

Implementation can start now. Nothing may ship to users until the external cryptographic review
(S-01..S-04) signs off.
