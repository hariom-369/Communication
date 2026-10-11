# Capacity model

Status: **measured in Phase 15** (harness: [load-testing.md](load-testing.md), ADR-053). Raw
results: `docs/load-results/phase-15/*.json`. Planning assumptions and stages: [scaling.md](scaling.md).

All numbers come from **one 4-core, 16 GB machine running everything** — the services,
PostgreSQL, Valkey and the load generators (which use about a third of the CPU) — so they are
conservative for the services and say nothing about network latency, TLS or a load balancer.

## 1. Exit criterion: Stage 2 with 3× headroom

Stage 2 (scaling.md) is 100k registered users: ~10k concurrent sockets and ~60 messages/s at
peak. With 3× headroom: **30,000 sockets and 180 messages/s**.

| Run | Load | Result | Verdict |
|---|---|---|---|
| steady (3 min) | 30,000 sockets, 180 msg/s, every delivery acked | send p50 7 ms, p95 36 ms, p99 131 ms; delivery (send start → frame on the peer's socket) p95 54 ms, p99 267 ms; 64,800/64,800 delivered; 0 errors | **met** |
| soak (30 min) | same | SOAK_RESULT | SOAK_VERDICT |
| reconnect storm, deploy | 30,000 sockets on 3 pods, 180 msg/s; one pod drained (SIGTERM) and restarted | DRAIN_RESULT | DRAIN_VERDICT |
| reconnect storm, crash | same; one pod SIGKILLed | CRASH_RESULT | CRASH_VERDICT |
| group burst | 1,024-member group (the E2EE cap), all online, 20 posts/s (20,480 deliveries/s) | GROUP_RESULT | GROUP_VERDICT |
| channel | 1,005,000 subscribers; a post every 2 s; 300 feed reads/s | publish p50 9 ms, p95 18 ms; feed read p95 8 ms; writes per subscriber per post: 0 (13 posts refused by the channel post rate limit, as designed) | **met** |
| call surge | 20 new 1:1 calls/s, 30 s each (600 concurrent) | ring p95 13 ms; setup (press call → callee joined) p95 24 ms; CALLS_NOTE | **met** |
| real MLS | 10 pairs of headless web clients (real encryption, 1 msg/s each way) under the 30,000 / 180 background | CRYPTO_RESULT | CRYPTO_VERDICT |

The machine's CPU was 2.1 of 4 cores at the target load (steady), of which the load
generators were ~0.3.

## 2. Where the limit is

The **knee** (latency rising steeply, open-loop) on this machine, 30,000 sockets, 2 API
processes, with acks: **≈ 270–300 messages/s** — p95 send 85–110 ms at 270, saturated (seconds)
at 360. Before delivery acks were modelled the knee was ≈ 540/s: acks are two of the three
writes per message.

**PostgreSQL is the bottleneck.** Per delivered direct message (one send, two acks — the
peer's and the sender's other device — and the receipts they publish):

| Component | CPU per message | Notes |
|---|---|---|
| PostgreSQL | ≈ 3.5 ms average, ≈ 4.4 ms marginal | mailbox insert and `last_seq` bump, two single-statement acks |
| API (both processes) | ≈ 4 ms average | session check, validation, CSRF, rate limits; three requests per message |
| Realtime, Valkey | not resolvable | ≤ 0.1 core per process at 180 and at 270 msg/s alike (the sampler's resolution) |

Average = mean CPU / messages per second at 180 and 270 msg/s (it includes the idle cost of
30,000 sockets); marginal = the CPU added from 180 to 270 msg/s.

**Idle sockets are cheap.** A realtime pod holds 15,000 sockets in 330–420 MB RSS (peak, with
traffic; roughly 20–25 KB per socket) at ≈ 0.1 core; the 19,000-socket cap here is the
file-descriptor limit, not CPU or memory. Production pods (50,000 sockets with a raised limit):
plan ≈ 1.5 GB.

**Connecting is not cheap.** A connect costs a ticket (`POST /realtime/ticket`: session check,
issue) and a `GET /sync` plus catch-up — about five queries. One API process completes about
**830 connects/s**; this is what a reconnect storm runs into (§4).

## 3. What made the target

Changes Phase 15 made because the measurements showed them necessary (each with a test):

- **Acks in one statement.** Acks are most of the write traffic; `acknowledge()` was a
  membership read, an update and a member scan. It is now one CTE (update + the members'
  positions) and the common case is one round trip (`messaging.ts`).
- **Group receipts only when the group's minimum moves.** Every ack in a group published a
  receipt to every member: members² frames per message — at 1,024 members, ~a million frames
  per post. Group receipts are now published only when the lowest acked position of the group
  advances, with that position.
- **Group acks without reading the whole group.** The first version of that check aggregated
  all members on every ack — members² row reads per message, which moved the collapse into
  PostgreSQL (group burst: sends averaging 80 s). The ack now asks only whether this member was
  the last one behind (`NOT EXISTS` stops at the first member at or behind it, usually within a
  row or two); the member list is read once per message, when a receipt is due.
- **Acks coalesced longer in large groups.** Every online member acknowledges what it receives;
  with the client's fixed 150 ms window one busy 1,024-member group produced ~7,000 ack
  requests per second. The window now grows with the group (4 ms per member, 150 ms – 5 s,
  `apps/web/src/messaging/ack-delay.ts`), bounding a busy group at ~250 acks per second
  whatever its size; "delivered to everyone" in a 1,024-member group shows ~4 s later.
  Together: the group burst went from sends averaging 80 s to p95 256 ms, and acks from
  ~3,500/s to 240/s.
- **Presence refresh batched.** The realtime heartbeat refreshed each socket's presence key
  one at a time; at 15,000 sockets per pod this stalled the event loop for hundreds of
  milliseconds every interval (delivery p99 1.1 s → 173 ms after). It now pipelines 1,000
  keys at a time and yields between batches (`gateway.ts`).
- **The web client ingests a pushed message directly.** A `message` frame that is the next
  message in order is decrypted from the frame; the client fetched it again before (one
  request per delivered message, the largest share of reads). Gaps still fetch (`store.ts`).

## 4. Reconnect storms and the settings they fixed

A realtime pod going away sends its sockets — up to 50,000 in production — back through the
API's ticket endpoint and the remaining pods.

- **Listen backlog.** Node's default backlog (511) overflowed: 141,949 SYNs dropped during one
  storm, each costing the client a 1–3 s retransmission while the server was idle.
  `LISTEN_BACKLOG` is now 4096 on API and realtime (effective up to `net.core.somaxconn`; see
  deployment.md).
- **Drain window 5 s → 30 s.** A deploy tells each client to reconnect after a random delay in
  the drain window. With 5 s, 15,000 clients came back within 5 s and saturated the API: sends
  of connected users took 8 s (p95). With 30 s, send p95 during a deploy was 37 ms.
  `SHUTDOWN_DRAIN_MS` 30 s, `SHUTDOWN_TIMEOUT_MS` 45 s (validated to exceed the drain by
  ≥ 10 s), so pods need `terminationGracePeriodSeconds` ≥ 50.
- **Cleanups before Valkey closes.** Shutdown closed Valkey while socket cleanups (presence,
  subscriptions) were still running, logging `cleanup_failed` for every socket and leaving
  presence keys to expire. Drain now awaits them.
- **N+1 realtime pods.** With two pods at 15,000 each, a drained pod's clients filled the
  survivor to its cap (19,000 here): 11,000 upgrades were refused with 503 and clients backed
  off for tens of seconds. The pods left after one fails must hold its sockets.
- **Ticket admission.** A crash has no drain hint: all of a pod's clients reconnect within
  the backoff's first seconds. Without a limit this starved sends of connected users
  (p95 8 s). `REALTIME_TICKETS_PER_SECOND` (default 500, cluster-wide, via the shared rate-limit
  store; fails open if the store is down) answers excess ticket requests with 429 and
  `Retry-After`; the web client now waits at least that long before its next attempt (it
  used its backoff alone before — `realtime-client.ts`, unit-tested and mutation-checked):
  reconnecting takes longer, the users who are connected keep working. Set it to what the API tier sustains alongside normal
  traffic (≈ 830 connects/s per API process here, minus headroom). CRASH_ADMISSION
- **Backoff base.** Doubling the client's base delay (2 s) did not shorten recovery; the
  admission budget is the lever, not the client.

## 5. The model for later stages

From §2, per 1 msg/s at peak (direct-dominated, as scaling.md assumes): ≈ 4.4 ms PostgreSQL
CPU and ≈ 4 ms API CPU; per 1,000 connected sockets: ≈ 25 MB realtime memory.

| Stage (3× headroom) | Sockets | msg/s | PostgreSQL CPU | API CPU | Realtime pods (50k, N+1) |
|---|---|---|---|---|---|
| 2 — 100k | 30k | 180 | ≈ 0.8 core | ≈ 0.7 core | 2 (1 + 1) |
| 3 — 1M | 300k | 1,800 | ≈ 8 cores | ≈ 7 cores | 7 (6 + 1) |
| 4 — 10M | 3M | 18,000 | ≈ 80 cores | ≈ 72 cores | 61 (60 + 1) |

So: Stage 2 fits the Stage 1 footprint of scaling.md (db.m7g.large, 2–3 API pods, 2 realtime
pods). Stage 3 needs a larger primary (16 vCPU at ≈ 50 % CPU) and ≈ 10 API pods — no
architectural change, which matches scaling.md. Stage 4's database load is past one primary:
this is the mailbox extraction / sharding of scaling.md Stage 3–4, and these figures are its
justification. Group and channel traffic change the realtime and Valkey side (fan-out), not
PostgreSQL: one mailbox row per message regardless of members (§1, channel: 0 writes per
subscriber).

**Validate in staging (Phase 17)** before relying on the model beyond Stage 2: the managed
database, real network and TLS, a load balancer, 50,000 sockets per pod, and the parts not
exercised here — TURN/SFU media (including the 32-participant call), push delivery and e-mail.
