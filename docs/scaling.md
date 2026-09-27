# Scaling strategy

Status: PROPOSED · Planning assumptions (to be validated by load tests in Phase 15):
DAU = 40% of registered; peak concurrent = 15% of DAU; 40 messages/DAU/day; peak/avg = 3×;
average 1.6 devices per user (sockets ≈ concurrent users × 1.6); average conversation fan-out 3 devices (1:1 dominated). One mailbox row per message regardless of device count (MLS). Design headroom: 3× these numbers.

| Stage | Registered | Peak concurrent sockets | Peak msgs/s | Mailbox rows/day |
|---|---|---|---|---|
| 1 | 10k | ~1k | ~6 | ~160k |
| 2 | 100k | ~10k | ~60 | ~1.6M |
| 3 | 1M | ~100k | ~600 | ~16M |
| 4 | 10M+ | ~1M+ | ~6k+ | ~160M+ |

Architecture invariants at every stage: stateless API/realtime pods, no local disk state,
horizontal scaling behind load balancers, idempotent workers, cursor pagination, per-conversation
(not global) serialization.

## Stage 1 — 10k users

Setup: 2–3 API pods, 2 realtime pods, RDS db.m7g.large Multi-AZ, Valkey small cluster,
1 TURN, 1 SFU. Bottlenecks: none technical; operational maturity (on-call, runbooks).
Cost focus: keep baseline small; avoid premature sharding.

## Stage 2 — 100k users

Bottlenecks and actions:
- **DB connections** → PgBouncer tuned; read replica for admin/analytics.
- **Outbox relay throughput** → partition relay by `hash(conversation_id)` across workers.
- **TURN/SFU bandwidth** → autoscaling groups; cost monitoring.
- **Link-preview/media worker** CPU → separate autoscaling queues.
- Notification fan-out → batch VAPID sends; per-provider concurrency.

## Stage 3 — 1M users

Bottlenecks:
- **Mailbox write/delete churn** in Postgres (16M inserts + deletes/day, vacuum pressure).
  Actions: hash partitioning already in place (64); tune autovacuum per partition; move to
  time+hash partitioning (drop old partitions instead of deleting rows); if still hot,
  **extract the mailbox into a dedicated store** (ScyllaDB/Cassandra keyed by
  `(conversation_id, seq_bucket)`) behind the existing `messaging` interface.
- **Sequence assignment** per conversation → unchanged semantics; implemented in the
  mailbox store with lightweight transactions or a sequencer service partitioned by conversation.
- **Valkey pub/sub** fan-out → Valkey cluster sharded pub/sub (`SPUBLISH`) keyed by node;
  or move event bus to NATS JetStream.
- **Job queue** → from Postgres-backed queue to NATS JetStream/Kafka.
- **Search** → OpenSearch for public content.
- **Channels with 1M subscribers** → CDN caching of feed pages, counters via async aggregation.
- **Multi-region reads**: CDN for web/public media; data remains in India.

## Stage 4 — 10M+ users

Bottlenecks:
- **Realtime connection density**: Node `ws` pods at ~50k sockets each → ~20+ pods per 1M;
  evaluate uWebSockets.js or a rewrite of the realtime edge in Go/Rust (protocol unchanged,
  ADR-002).
- **Core DB** (accounts, conversations, memberships) → vertical headroom first, then
  shard by `user_id` / `conversation_id` (Citus or application-level sharding with a
  directory); conversations and their members co-located by conversation shard; user
  inbox index co-located by user shard.
- **Presence** → dedicated presence service with sharded Valkey, subscriptions only for
  visible contacts, aggressive coalescing.
- **KeyPackage traffic** → own store; cache hot devices.
- **SFU cascading** across edge PoPs; TURN anycast/geo-DNS.
- **Cost**: bandwidth (media, calls) dominates → egress optimisation, possibly own
  bare-metal for TURN/SFU.
- **Organisational**: extract modules into services where team ownership + scaling justify
  it (candidates in order: realtime, mailbox, media, notifications, channels).

## Load testing (Phase 15)

k6 (HTTP + WebSocket) with synthetic MLS-shaped payloads (ciphertext-sized random bytes;
real crypto in a smaller fleet of headless clients); scenarios: steady chat, reconnect storm
after deploy, 1,024-member group burst, channel publish to 1M subscribers, call setup
surge; soak 24 h. Capacity model updated from results.
