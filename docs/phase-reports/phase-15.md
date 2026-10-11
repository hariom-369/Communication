# Phase 15 report — Load testing

**Status: GATE_STATUS.** Verified 2026-10-11. CI has not run, because the branch still cannot
be pushed (GitHub returns 403 for the Claude app).

Stage 2 of the scaling plan (100k registered users) with 3× headroom — **30,000 concurrent
sockets and 180 messages/s** — was met on a single 4-core machine that also ran PostgreSQL,
Valkey and the load generators, over 3 and 30 minutes, with nothing lost. Getting there found
and fixed nine problems in the services and the web client, most of which would have shown up
in production only under load: a quadratic group fan-out (twice), a heartbeat that stalled the
realtime event loop, a deploy drain too short for its pod, dropped connections in the kernel
backlog, shutdown cleanups racing the Valkey close, a client that refetched every message it was
pushed, and reconnect waves after a crash that starved connected users. Harness: ADR-053,
[load-testing.md](../load-testing.md). Results and the capacity model:
[capacity.md](../capacity.md).

## Results

| Gate | Result |
|---|---|
GATE_ROWS

### Exit criterion: Stage 2 with 3× headroom

| Run | Load | Result |
|---|---|---|
| steady, 3 min | 30,000 sockets, 180 msg/s, every delivery acked | send p50 7 ms, p95 29 ms, p99 131 ms; delivery p95 42 ms, p99 240 ms; 64,800/64,800 delivered; 0 errors |
| soak, 30 min | same | SOAK_ROW |
| reconnect storm, deploy | 30,000 sockets on 3 pods; one drained and restarted | DRAIN_ROW |
| reconnect storm, crash | same; one pod SIGKILLed | CRASH_ROW |
| group burst | 1,024-member group, all online, 20 posts/s (20,480 deliveries/s) | send p50 33 ms, p95 256 ms; 1,228,800/1,228,800 delivered |
| channel | 1,005,000 subscribers, a post every 2 s, 300 feed reads/s | publish p95 18 ms; feed read p95 8 ms; 0 writes per subscriber |
| call surge | 20 new 1:1 calls/s, 30 s each (600 concurrent) | ring p95 15 ms; setup p95 28 ms |
| real MLS | 10 pairs of headless web clients under the 30,000 / 180 background | 2,420/2,420 decrypted, in order; end-to-end p95 404 ms |

**Met.** The knee on this machine is ≈ 270–300 msg/s with acks (PostgreSQL-bound, ≈ 4.4 ms of
database CPU per delivered direct message), i.e. 1.5× beyond the 3× target; capacity.md §2
derives the model for later stages from it.

## Delivered

- **`tests/load`** (ADR-053): a Node load harness instead of k6. The services run from their
  production builds (N API, M realtime processes) on a fresh database; accounts are seeded in
  SQL (the only shortcut — sign-up would spend the run on Argon2id); generator processes hold
  virtual users that speak the public protocol as the web app does (cookie + CSRF header,
  single-use ticket, `tessera.v1`, `auth` frame, coalesced acks, catch-up after every reconnect,
  the app's backoff, `Retry-After`, reconnect spread) from 40+ loopback source addresses;
  open-loop schedules; mergeable log histograms; CPU/memory sampling of every process; slow-send
  windows; JSON results.
- **Headless web clients**: the app's own `MessagingStore`, `E2eeSession` and Rust/WASM engine,
  unchanged, in worker threads (in-memory IndexedDB, in-process RPC boundary, `fetch` and `ws`
  bound to the user's cookie and source address) — real device registration, KeyPackages,
  Welcomes and MLS application messages.
- **Scenarios**: steady, storm (drain/crash), group, channel, calls, crypto; options for scale,
  rate, duration, pods and environment overrides for tuning experiments.
- **Service and client changes** — see "Problems found and fixed".
- **Docs**: load-testing.md, capacity.md (results, per-message costs, findings, model for
  Stages 2–4), ADR-053, deployment.md "Settings the load tests fixed", realtime.md, scaling.md,
  testing.md, threat-model delta, release-signing-key runbook (promised in Phase 14).

## Problems found and fixed during the phase

| # | Found by | Problem | Fix | Test |
|---|---|---|---|---|
| 1 | steady | Realtime heartbeat refreshed each socket's presence key one by one: event-loop stalls, delivery p99 1.1 s | pipelined in batches of 1,000 with yields; p99 173 ms | integration (presence refresh) |
| 2 | storm drain | Shutdown closed Valkey while socket cleanups ran: `cleanup_failed` per socket, stale presence | drain awaits cleanups | integration with a slow-Valkey proxy (the first test missed the bug; mutation-checked) |
| 3 | storm drain | 5 s drain window: 15,000 clients back within 5 s, connected users' sends p95 8 s | 30 s drain, 45 s shutdown timeout (validated) | config unit tests |
| 4 | storm | Node's listen backlog (511): 141,949 SYNs dropped, 1–3 s retransmits | `LISTEN_BACKLOG` 4096 on API and realtime | config unit tests |
| 5 | steady | Ack = three round trips; acks are most of the writes | one statement | integration (non-member, stale ack) |
| 6 | group | A receipt per member per ack: members² frames per message | group receipts only when the group's minimum advances | integration, mutation-checked both ways |
| 7 | group | That check aggregated all members on every ack: members² row reads; acks every 150 ms from every member (~7,000/s for one group) | `NOT EXISTS` stops at the first member behind; ack window grows with group size (≤ ~250 acks/s per group) | integration (incl. ties), unit; mutation-checked |
| 8 | crypto | Web client refetched every pushed message; a frame handler rejection was unhandled | next-in-order frames decrypted directly; rejections caught | store unit tests, mutation-checked |
| 9 | storm crash | A crashed pod's clients all reconnected within 500 ms; refused tickets cost as much as granted ones and came back after ~1 s | client spreads the first reconnect after an unexpected drop over 5 s and honours `Retry-After`; refused tickets get a random 1–10 s `Retry-After`; cluster-wide ticket admission | unit tests (client, spread), integration (admission); mutation-checked |

Harness problems found and fixed on the way (they would have made results wrong, not the
product): undici ignoring `localAddress` (every headless client on one address → 429s); the
coordinator running out of memory with 20 WASM clients (worker heap limits); orphaned services
from a killed run holding ports (pid file, port checks); a peer told to send before its client
knew the conversation (the 10 "lost" messages of an early crypto run); reconnects all sent to
the next pod in order (a load balancer spreads them); a first connect not retried; my own
security scan during a soak (an 11–20 s tail that a clean rerun did not show).

## Security implications (threat-model delta)

No new trust boundary or data flow; the harness runs only against a disposable local stack. The
changes are availability (T-18): ticket admission and spread retries, backlog, drain window,
N+1 sizing, the end of two members² fan-outs a large group could trigger by chatting. Residual:
admission is cluster-wide (a flood of valid sessions slows everyone's reconnects, each account
still held to 60 tickets a minute); the admission counter fails open without Valkey; a
per-address cap on unauthenticated sockets belongs at the edge (Phase 17); figures come from one
machine. Logged and stored: nothing new — results contain latencies, counts and resource
figures, no message content (payloads are random bytes; headless clients' plaintext is
`load:<time>:<n>` and never leaves the worker except as its number).

## Open items

- Re-measure in staging (Phase 17): managed PostgreSQL, real network and TLS, a load balancer,
  50,000 sockets per pod, 24-hour soak.
- Choose `REALTIME_TICKETS_PER_SECOND` per environment from staging measurements
  (deployment.md).

## Moved / not done

- 32-participant call and TURN/SFU media capacity (moved here from Phase 9) → staging,
  Phase 17: hardware- and bandwidth-bound; the call-setup surge here covers signalling only.
- Firefox/Safari push and PWA tests in a CI browser matrix (moved here from Phase 14) → CI,
  which cannot run until the branch can be pushed; Phase 17 at the latest.
- Transparency log and reproducible builds (Phase 14) → release pipeline, Phase 17.
- 24-hour soak → staging, Phase 17 (the longest run here is 30 minutes).
- CAPTCHA-style challenges and risk scores (moved from Phase 11 to "12/15", taken up in
  neither) → before public beta.
- Per-address cap on unauthenticated sockets → edge/WAF, Phase 17.

## Commit

COMMIT_LINE
