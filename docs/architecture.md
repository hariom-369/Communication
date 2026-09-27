# System architecture

Status: PROPOSED · Decisions: ADR-001, 002, 003, 018, 020, 023, 026, 029

## 1. Principles

1. **Plaintext of private conversations never reaches servers.** Server components are
   designed so that they *cannot* read it, not merely *do not*.
2. **Stateless compute, stateful stores.** No critical state in process memory or local disk.
3. **Modules with contracts.** Every domain module exposes a typed interface; other modules
   may not touch its tables.
4. **Secure by default.** Deny-by-default authorization, allow-list validation, allow-list logging.
5. **Operate for failure.** Every dependency has timeouts, retries with jitter, circuit
   breakers and a documented degraded mode.

## 2. Context diagram

```
                         ┌────────────────────────────────────────────┐
  Users (browser/PWA,    │                 Tessera                    │
  later desktop/mobile)  │                                            │
  ──── HTTPS/WSS ───────▶│  Edge: CloudFront + WAF ─▶ ALB/NLB         │
  ──── WebRTC (UDP/TCP) ▶│  TURN (coturn) / SFU (LiveKit)             │
                         │                                            │
  Admin staff ─ZTNA/SSO─▶│  Admin app (separate origin, IP/ZTNA-gated)│
                         └───────┬───────────────────┬────────────────┘
                                 │                   │
               Email (SES) ◀─────┤                   ├────▶ Payment providers
               Web Push services ◀┤                   │     (Razorpay, Stripe)
               SMS/OTP provider ◀─┘                   └────▶ Malware scan / hash-matching (public content)
```

## 3. Container view

```
             ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  Browser ──▶│ web (static) │     │ admin (static│     │  CDN (public │
             │ React SPA    │     │ separate org)│     │  media)      │
             └──────┬───────┘     └──────┬───────┘     └──────────────┘
                    │ REST /api/v1        │ REST /admin/v1
                    ▼                     ▼
             ┌─────────────────────────────────────────┐
             │ services/api  (modular monolith, N pods)│
             │  auth · users · devices · keys ·        │
             │  messaging · groups · communities ·     │
             │  channels · media · calls · notif-      │
             │  dispatch · moderation · billing ·      │
             │  entitlements · privacy · admin · audit │
             └───┬─────────┬──────────┬───────────┬────┘
                 │         │          │           │ outbox events
        ┌────────▼──┐ ┌────▼─────┐ ┌──▼──────┐ ┌──▼─────────────────┐
        │PostgreSQL │ │ Valkey   │ │ S3      │ │ Job queue (Postgres │
        │(PgBouncer)│ │ cluster  │ │ buckets │ │ outbox → workers)   │
        └────▲──────┘ └──▲───▲───┘ └──▲──────┘ └──┬─────────────────┬┘
             │           │   │        │           │                 │
    ┌────────┴─────┐     │   │  ┌─────┴──────┐ ┌──▼───────────┐ ┌───▼─────────┐
    │services/     │◀────┘   │  │services/   │ │services/     │ │services/    │
    │realtime (WSS)│ pub/sub │  │media       │ │notification  │ │calling      │
    │M pods        │─────────┘  │(scan/trans)│ │(push/email)  │ │(token issue,│
    └──────▲───────┘            └────────────┘ └──────────────┘ │ LiveKit ctl)│
           │ WSS                                                 └──────┬──────┘
        Browser                                               LiveKit SFU + coturn
```

- **api**: all REST, all business rules, all writes of record.
- **realtime**: terminates WebSockets; authenticates via session; subscribes to per-device
  routing channels; forwards frames; *never* makes business decisions beyond rate-limiting
  and schema validation — writes go to `api` internal RPC or directly via the messaging
  module library (shared package, same DB) — see [realtime.md](realtime.md) §3.
- **media**: virus scanning / transcoding for public content, upload finalisation,
  lifecycle cleanup. Never receives E2EE keys.
- **notification**: consumes outbox events, applies user notification prefs, sends web push
  (VAPID), email.
- **calling**: issues TURN credentials and LiveKit join tokens; call state machine.

## 4. Module (domain) map

| Module | Owns (tables) | Key interfaces | Sees plaintext of private msgs? |
|---|---|---|---|
| auth | credentials, passkeys, sessions, mfa, recovery_codes | `authenticate`, `createSession`, `revoke` | No |
| users | users, profiles, usernames, privacy_settings | `getProfile(viewer, id)` (privacy-filtered) | No |
| devices | devices, device_certificates, account_keys | `registerDevice`, `listVerifiedDevices` | No |
| keys | key_packages | `publishKeyPackages`, `claimKeyPackage` | No |
| messaging | conversations, conversation_members, mailbox_messages, device_cursors | `submit`, `fetchSince`, `ack` | **No — ciphertext only** |
| groups | group_meta, roles, invites, join_requests, bans | policy checks for membership changes | No (metadata only) |
| communities | communities, community_roles, community_channels | | No |
| channels | channels, channel_posts, subscriptions | | **Yes — channels are not E2EE** (ADR-012) |
| media | blobs, upload_sessions | `createUpload`, `finalize`, `signDownload` | No for E2EE blobs; yes for public |
| calls | calls, call_participants | `startCall`, `joinToken` | No (media E2EE) |
| notifications | push_subscriptions, notification_prefs | `notify(event)` | No |
| moderation | reports, cases, actions, appeals, evidence | | Only content the reporter explicitly submits |
| billing / entitlements | plans, subscriptions, invoices, entitlements | `can(user, feature)` | No |
| privacy | exports, deletion_requests, consents | | No |
| admin / audit | admin_users, admin_roles, audit_log | | No |
| analytics | aggregated events (no content) | | No |

## 5. Request lifecycle (REST)

```
CloudFront/WAF → ALB → Fastify
  1. request-id + OTel trace context
  2. body-size limit (default 64 KiB; route-specific)
  3. security headers (onSend)
  4. Origin / Fetch-Metadata / CSRF header check (state-changing routes)
  5. session resolution (cookie → hash → Valkey cache → Postgres)
  6. rate limit (GCRA in Valkey; keys: ip, user, device, route)
  7. Zod schema validation (params, query, body) → typed DTO
  8. authorization (policy function per route; deny by default)
  9. module service call (transaction where required)
 10. DTO mapping (never serialise DB rows)
 11. error mapper → RFC 9457 problem+json, no internals
 12. audit event (for listed actions) + metrics
```

Every route is declared with a single definition object:
`{ method, path, auth, authorize, schema: {params, query, body, response}, rateLimit, audit }`.
A CI test enumerates routes and fails if any field is missing ([testing.md](testing.md) §4).

## 6. Asynchronous work

Transactional **outbox** table written in the same transaction as the state change;
a relay publishes to (a) Valkey pub/sub for realtime fan-out, (b) the job queue
(`graphile-worker`-style Postgres queue initially) for notifications, media processing,
exports, deletions. Consumers are idempotent (event id dedupe). At scaling stage 3 the
queue moves to a dedicated broker (NATS JetStream or Kafka) — [scaling.md](scaling.md).

## 7. Service-to-service security (zero-trust posture, NIST SP 800-207)

- Pods authenticate with workload identity (mTLS via service mesh or IRSA + signed
  internal JWT with 60 s lifetime and audience restriction).
- No implicit trust from network location; Kubernetes NetworkPolicies default-deny.
- Database credentials per service with least privilege (e.g. `realtime` cannot read
  `credentials` table). Postgres roles per module where practical.

## 8. Configuration and secrets

- Typed config loaded once from env, validated with Zod at boot; the process refuses to
  start on invalid/missing config. No hardcoded URLs.
- Secrets from AWS Secrets Manager via External Secrets Operator; never in images, repo
  or logs. `.env.example` documents keys only.

## 9. Web client architecture

```
 Main thread (React UI)                 Crypto Worker (WASM)          Service Worker
 ───────────────────────                ───────────────────           ──────────────
 routes/views, design system            crypto-core (OpenMLS)         app-shell cache
 TanStack Query (REST cache)            key store (IndexedDB,         push handling
 realtime client (WSS)  ── frames ──▶   AES-GCM at rest)              background sync
 local message DB (IndexedDB, via       encrypt/decrypt, verify,
   worker; encrypted at rest)           backup encryption
```

- Plaintext message cache is stored in IndexedDB **encrypted by the worker**.
- State: server state in TanStack Query; conversation timeline in a worker-owned store
  exposed through a typed message-port RPC. No global mutable singletons outside it.
- UI: `packages/ui` design system (tokens, Radix-style accessible primitives, our own
  visual identity), CSS variables for dark/light, `prefers-reduced-motion` respected.

## 10. Failure modes (summary)

| Dependency down | Behaviour |
|---|---|
| Valkey | API serves with DB-backed session lookup (slower); rate limiting fails **closed** for auth endpoints, open with conservative in-process limits elsewhere; realtime nodes cannot fan out → clients fall back to polling `fetchSince` every 10 s |
| PostgreSQL primary | Multi-AZ failover (~60–120 s); writes return 503 with `Retry-After`; clients queue locally |
| S3 | Uploads fail with retry; text messaging unaffected |
| SFU | Calls fail; 1:1 P2P calls unaffected where direct path exists |
| Push provider | Notifications delayed; in-app delivery unaffected |
