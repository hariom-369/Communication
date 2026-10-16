# Architecture decision log

Every decision has: **Decision**, **Alternatives considered**, **Trade-offs**, **Status**.
Status values: `PROPOSED` (Phase 0 default), `NEEDS-SECURITY-REVIEW`, `NEEDS-LEGAL-REVIEW`,
`ACCEPTED`, `SUPERSEDED`. A decision may not move to ACCEPTED while it has an open review
item in [review-register.md](review-register.md).

---

## ADR-001 — Modular monolith with independently deployable edges

**Decision.** One TypeScript codebase for the business domains (`services/api`) organised as
strict modules (auth, users, devices, messaging, groups, …) that talk only through
published interfaces. From day one, the following run as **separate deployables** because
their scaling/runtime profile is genuinely different: `realtime` (long-lived WebSockets),
`media` workers (CPU/IO heavy), `notification` workers, and the SFU/TURN tier (third-party
software). Modules share one PostgreSQL cluster but own their tables (no cross-module joins
in code; cross-module reads go through module interfaces).

**Alternatives.** (a) Microservices from day one — rejected: operational cost, distributed
transactions, and slower iteration with no load to justify it. (b) Single process
including WebSockets — rejected: WebSocket connection draining makes API deploys slow and
couples scaling of two very different workloads.

**Trade-offs.** Discipline required to keep module boundaries; enforced by lint rules
(`eslint-plugin-boundaries`) and architecture tests.

**Status.** PROPOSED.

## ADR-002 — Language and runtime

**Decision.** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
on Node.js 24 LTS; Fastify 5 HTTP framework; Zod for runtime validation and DTO schemas;
Rust for the cryptographic core (`packages/crypto-core`), compiled to WASM for web and
(later) to native via UniFFI for mobile/desktop.

**Alternatives.** Go or Elixir for realtime (excellent for connection-heavy workloads) —
deferred: a second backend language before load proves the need hurts velocity; the
realtime service is isolated behind a protocol, so it can be rewritten later
(see [scaling.md](scaling.md) stage 4). NestJS — rejected for decorator-heavy DI and
weaker schema-first ergonomics than Fastify + Zod.

**Trade-offs.** Node single-thread per process; realtime nodes scale horizontally instead.

**Status.** PROPOSED.

## ADR-003 — Data stores

**Decision.** PostgreSQL 17 (managed, Multi-AZ, PITR) as system of record; Kysely typed
query builder; forward-only SQL migrations; PgBouncer (transaction pooling). Valkey 8
(ADR-029) for cache, presence, rate limits, ephemeral state, pub/sub. S3-compatible
object storage for media, backups, exports. OpenSearch only when ADR-025 triggers are met.

**Alternatives.** Cassandra/ScyllaDB for messages from day one — deferred to scaling stage 3
(mailbox store extraction, [scaling.md](scaling.md)); ORM (Prisma/TypeORM) — rejected: we
need explicit SQL control over locking, partitioning and indexes.

**Status.** PROPOSED.

## ADR-004 — E2EE protocol: MLS (RFC 9420) via OpenMLS

**Context.** Requirements demand Signal-style properties: per-device identity keys,
prekeys, asynchronous session establishment, forward secrecy (FS), post-compromise
security (PCS), ratcheting, device verification, key-change detection, multi-device, and a
separate evaluation of group encryption. The launch client is the **web**.

**Options evaluated.**

| Option | Maturity | License | Web/WASM | Groups | Multi-device | PQ |
|---|---|---|---|---|---|---|
| **libsignal** (X3DH/PQXDH + Double/Triple Ratchet, Sender Keys) | Highest; billions of users | **AGPL-3.0** | No official browser build; Signal states third-party use is unsupported | Sender Keys (no PCS for groups without re-keying) | Sesame fan-out (one ciphertext per recipient device) | PQXDH + SPQR (ML-KEM-768) |
| **vodozemac** (Olm/Megolm) | Production in Matrix; audited 2022; further issues publicly reported Feb 2026 | Apache-2.0 | Yes (matrix-sdk-crypto-wasm) | Megolm (weak PCS; historical-key exposure noted in audit) | Olm fan-out + cross-signing | None shipped |
| **OpenMLS** (MLS RFC 9420) | IETF standard; audited by SRLabs; in production at Wire (incl. web) | MIT | Yes | TreeKEM: O(log n) updates, PCS for groups | Native — each device is a leaf | X-Wing hybrid shipped (no IANA code point); ML-KEM suites behind draft flag |

**Decision.** Use **MLS via OpenMLS for all E2EE conversations (1:1 and groups)**, wrapped
in our own Rust crate that exposes a narrow, versioned API. We do not implement any
primitive or protocol logic ourselves; our code is orchestration (state storage, transport
binding, credential validation policy).

**Why not libsignal.** AGPL network clause would require source availability for any
server/client linking it (acceptable only if the company chooses to open-source clients —
a business decision, L-10); no supported browser target; Signal explicitly doesn't support
third-party use. If the business later decides to open-source clients and ship native-first,
libsignal remains the strongest pairwise option; our `CryptoProvider` abstraction keeps
that door open.

**Why not Megolm.** Weaker group PCS and known historical-key exposure properties.

**Trade-offs of MLS (documented honestly).**
- MLS needs a **Delivery Service that orders commits** per group; the server learns group
  membership and epoch changes (it would learn membership for routing anyway).
- FS/PCS granularity differs from the Double Ratchet: PCS happens when a member **commits
  an update**, not on every message reply. We schedule periodic self-updates (every 7 days
  or 100 sent messages, whichever first) and on suspicious events ([crypto-design.md](crypto-design.md) §6).
- 1:1 as a two-member MLS group has slightly higher overhead than pairwise ratchets; in
  return multi-device is native and every message is encrypted once, not per device.

**Status.** NEEDS-SECURITY-REVIEW (S-01). Top-priority review item.

## ADR-005 — Post-quantum readiness

**Decision.** Ciphersuite agility is mandatory (ciphersuite ID in every group and
KeyPackage; clients advertise supported suites). Target for GA: hybrid KEM ciphersuite
(X-Wing: X25519 + ML-KEM-768) for all new groups, **if** cryptographer review (S-02)
accepts deploying a suite without a final IANA code point inside our closed ecosystem.
Fallback: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001) with a documented
migration plan. Signatures remain Ed25519 (PQ signatures protect against future
impersonation, not harvest-now-decrypt-later, which is the urgent risk).

**Alternatives.** Classical-only (harvest-now-decrypt-later exposure); pure-PQ (no hedge
against ML-KEM implementation flaws).

**Status.** NEEDS-SECURITY-REVIEW (S-02).

## ADR-006 — Where client cryptography runs (web)

**Decision.** `crypto-core` (Rust → WASM) runs inside a **dedicated Web Worker**. The main
thread never holds private keys or MLS state; it sends plaintext to the worker and receives
ciphertext (and vice-versa). Persistent crypto state lives in IndexedDB, encrypted with
AES-256-GCM under a **non-extractable** WebCrypto key also stored in IndexedDB. Randomness
comes from `crypto.getRandomValues` (via `getrandom`'s `js` backend).

**Honest limits.** Worker isolation reduces accidental key exposure and makes key
exfiltration by injected scripts harder, but **an XSS in our origin can still ask the worker
to decrypt/sign**. At-rest encryption with a key stored alongside the data protects only
against casual disk/backup copies of the browser profile, not against malware on the
device. See [e2ee.md §7](e2ee.md). Wire documents the same limitation for its WASM keystore.

**Status.** NEEDS-SECURITY-REVIEW (S-03).

## ADR-007 — Identity model: account signing key + device credentials (cross-signing)

**Decision.** Each user has an **Account Signing Key (ASK, Ed25519)** generated on their
first device. Each device has its own MLS signature key; its MLS credential is a
`DeviceCertificate` signed by the ASK. Peers trust a device iff its certificate chains to
the user's ASK. **Safety numbers are derived from ASKs**, so adding a device does not change
a safety number; an ASK change does, and triggers a key-change warning. The ASK private key
is held on linked devices that the user designates as *trusted* (default: all devices
linked by QR) and in the encrypted backup. The server stores only public ASKs and signed
device certificates.

**Alternatives.** Per-device safety numbers (Signal model) — rejected: verification burden
grows with devices and users ignore it. Server-attested device lists without user
signatures — rejected: a compromised server could silently add a device (the ghost-device
attack).

**Status.** NEEDS-SECURITY-REVIEW (S-04).

## ADR-008 — Every conversation is one MLS group containing all member devices

**Decision.** 1:1 chat = MLS group of all devices of both users; group chat = all devices of
all members. Adding/removing a device is an MLS Add/Remove commit. Group application
messages are encrypted once and fanned out by the server.

**Status.** PROPOSED (depends on ADR-004).

## ADR-009 — Server as MLS Delivery Service with per-conversation ordering

**Decision.** The server assigns a strictly increasing `seq` per conversation and accepts
a commit for epoch *N* only if the group is at epoch *N* (compare-and-set); concurrent
commits are rejected with `409 EPOCH_CONFLICT` and the client re-bases. Application
messages carry epoch; the server does not need to understand their content.

**Status.** PROPOSED.

## ADR-010 — Server retention of E2EE ciphertext ("mailbox")

**Decision.** The server stores E2EE message ciphertext only until every current member
device has acknowledged it **or 30 days** elapse, whichever is first. After that, history
exists only on devices and in user-controlled encrypted backups. New devices obtain
history via device-to-device transfer ([multi-device.md](multi-device.md) §5) or backup restore.

**Alternatives.** Retain ciphertext indefinitely — useless for new devices (MLS forward
secrecy deletes old epoch keys by design) and increases breach impact/metadata.

**Trade-offs.** A device offline >30 days loses messages from that window; UX must warn.

**Status.** PROPOSED; retention period needs legal check vs CERT-In/DPDP log rules (L-08).

## ADR-011 — E2EE group size cap

**Decision.** E2EE groups up to **1,024 members** at launch (member count, not devices;
enforce a device cap of 5,000 leaves). Larger audiences use **large rooms** (community
channels) or **broadcast channels**, which are server-protected, not E2EE, and labelled.
Cap will be raised after load tests of commit sizes and welcome processing on low-end devices.

**Status.** PROPOSED.

## ADR-012 — Channels and large rooms are not E2EE

**Decision.** Broadcast channels and large community rooms store posts server-side,
encrypted at rest (server keys), readable by the service for delivery, search, moderation
and legal obligations. Separate module (`channels`) with its own tables and delivery path
(fan-out on read + CDN), not the E2EE mailbox.

**Rationale.** Public broadcast to 1M subscribers gains nothing from E2EE (anyone can
subscribe) and needs search, moderation, analytics.

**Status.** PROPOSED.

## ADR-013 — Media encryption and storage

**Decision.** In E2EE conversations the client encrypts each file with a fresh 256-bit key
using libsodium `secretstream_xchacha20poly1305` (chunked, 64 KiB chunks, authenticated,
truncation-resistant), uploads ciphertext via presigned S3 multipart URLs, and sends
`{blobId, key, header, plaintextSha256, ciphertextSha256, size, mime}` inside the MLS
message. Thumbnails are generated **on the sending client** and encrypted the same way.
Public/channel media is scanned and transcoded server-side and served via CDN.

**Status.** NEEDS-SECURITY-REVIEW (S-05, construction and metadata).

## ADR-014 — Encrypted backups

**Decision.** A random 256-bit **Backup Root Key (BRK)** encrypts backups
(secretstream). The BRK is wrapped by: (1) a user-held **recovery key** (256-bit random,
shown as 52 base32 characters / QR); and optionally (2) a **passkey PRF**-derived key where the
authenticator supports the WebAuthn PRF extension. **Password-only backup encryption is not
offered** until we operate an HSM-backed, rate-limited key vault (like WhatsApp's
Backup Key Vault): with only a password, the server (or anyone who leaks the blob) could
brute-force it offline.

**Status.** NEEDS-SECURITY-REVIEW (S-06).

## ADR-015 — Web session model

**Decision.** Opaque, 256-bit random session tokens in a `__Host-tsid` cookie
(`Secure; HttpOnly; SameSite=Lax; Path=/`), server-side session records (Postgres, cached in
Valkey), stored as SHA-256 hash. No JWTs for browser sessions. Native clients (later) use
device-bound refresh tokens with DPoP-style proof of possession. CSRF: SameSite + mandatory
custom header + Origin/Fetch-Metadata checks.

**Alternatives.** JWT access + refresh tokens in JS — rejected (token theft via XSS,
revocation complexity). BFF — equivalent to what we are building (the API is the BFF for web).

**Status.** PROPOSED.

## ADR-016 — 1:1 calls

**Decision.** WebRTC peer-to-peer with DTLS-SRTP; signalling (SDP offers/answers, ICE) sent
**as MLS-encrypted messages**, so the DTLS fingerprints are authenticated by E2EE and the
server cannot MITM. TURN (coturn) with short-lived HMAC credentials; `iceTransportPolicy:
relay` option in privacy settings to hide IP from peers.

**Status.** ACCEPTED — implemented in Phase 9; details and deviations in ADR-047.

## ADR-017 — Group calls

**Decision.** Self-hosted **LiveKit** SFU (Apache-2.0). Media frames E2EE-encrypted in the
browser via WebRTC Encoded Transform, using SFrame (RFC 9605) with keys derived from the
conversation's MLS exporter secret (`MLS-Exporter("tessera call", callId, 32)`), re-keyed
on membership change. SFU sees only encrypted frames plus RTP headers/metadata.

**Alternatives.** mediasoup (library, more build effort); Jitsi (Java stack, heavier).
Browser support gaps for encoded transforms → calls without E2EE are **not** silently
allowed; unsupported browsers are blocked from E2EE calls with an explanation.

**Status.** IMPLEMENTED in Phase 9, NEEDS-SECURITY-REVIEW (S-08). The keying was changed to
RFC 9605 §5.2 (ADR-047) instead of the construction sketched above.

## ADR-018 — Web client architecture

**Decision.** React 19 + Vite, static SPA, served from object storage/CDN with immutable
hashed assets, strict CSP (no `unsafe-inline`, no `unsafe-eval` except `wasm-unsafe-eval`),
Trusted Types, SRI. No SSR (avoids server-rendered user content surface and keeps the
bundle hashable/publishable). Admin is a **separate app on a separate origin**.

**Status.** PROPOSED.

## ADR-019 — Higher-assurance desktop client (post-GA)

**Decision.** Tauri desktop app with signed, reproducible builds shipping the same Rust
crypto natively; addresses web code-delivery trust. Not in launch scope.

**Status.** PROPOSED.

## ADR-020 — Wire formats

**Decision.** Protobuf (managed with `buf`, breaking-change checks in CI) for WebSocket
frames and for the **plaintext inside MLS application messages** (cross-platform, compact,
versioned). JSON over REST with OpenAPI 3.1 generated from Zod schemas.

**Status.** PROPOSED.

## ADR-021 — Abuse reporting for E2EE content

**Decision.** Reporting E2EE content is always an **explicit user action** that re-sends the
selected messages (and optional context of up to N previous messages chosen by the user)
to Tessera. To make reports verifiable and prevent fabricated reports, evaluate **message
franking** (committing AEAD / HMAC commitment over the plaintext, stored by server at
delivery, per Grubbs et al. 2017). Until reviewed, reports are treated as unverified
evidence.

**Status.** PROPOSED — franking implemented in Phase 11 (ADR-049); NEEDS-SECURITY-REVIEW (S-10).

## ADR-022 — Bots and automation

**Decision.** Bot platform first targets non-E2EE surfaces (channels, large rooms,
community moderation). A bot in an E2EE group is a **visible member with its own
device/credential**; adding it shows a clear warning that the bot operator can read
messages. No server-side "invisible" bot access.

**Status.** PROPOSED.

## ADR-023 — Hosting

**Decision.** AWS `ap-south-1` (Mumbai) primary, `ap-south-2` (Hyderabad) DR; EKS for
workloads; RDS PostgreSQL Multi-AZ; ElastiCache for Valkey; S3 (+ CRR); CloudFront; AWS
WAF + Shield Advanced at scale; KMS for server keys; Secrets Manager. Terraform for all
infrastructure. Keeps logs and data in India (CERT-In log locality).

**Alternatives.** GCP/Azure (equivalent); bare-metal (cost at 10M+, revisit in scaling stage 4).

**Status.** PROPOSED.

## ADR-024 — Billing

**Decision.** `billing` module owns plans, subscriptions, invoices; `entitlements` module
exposes `can(user, feature)`/limits to all other modules. Payment providers behind an
adapter: Razorpay (India, UPI Autopay / e-mandates), Stripe (international). Messaging
never calls billing directly.

**Status.** NEEDS-LEGAL-REVIEW (L-11 RBI/GST/consumer rules).

## ADR-025 — Search

**Decision.** Public directory search (users by exact username, public groups, channels,
communities, public posts) on PostgreSQL FTS + `pg_trgm`. Introduce OpenSearch when
p95 search latency >300 ms or corpus >50M public posts. Private messages are searchable
**only on device** (encrypted local index).

**Status.** PROPOSED.

## ADR-026 — Observability

**Decision.** OpenTelemetry SDK for traces/metrics/logs; Prometheus + Grafana, Loki,
Tempo (or AWS managed equivalents); Sentry-compatible error tracking with scrubbing.
Structured JSON logs via pino with an allow-list serializer (fields not on the allow-list
are dropped, not redacted-after-the-fact).

**Status.** PROPOSED.

## ADR-027 — Monorepo tooling

**Decision.** pnpm workspaces + Turborepo; Cargo workspace for Rust; ESLint (typescript-eslint
strict), Prettier, Vitest, Playwright; Changesets for internal versioning.

**Status.** PROPOSED.

## ADR-028 — Identifiers and ordering

**Decision.** UUIDv7 for all entity IDs (time-ordered, index-friendly, globally unique,
client-generatable for idempotency). Conversation ordering by server-assigned `seq`
(bigint) per conversation; cursors are opaque, signed `(conversation_id, seq)` tokens.

**Status.** PROPOSED.

## ADR-029 — Valkey instead of Redis

**Decision.** Use Valkey (BSD-3, Linux Foundation) — protocol compatible; Redis's 2024
license change to RSAL/SSPL (and later AGPL option) creates avoidable licensing review.

**Status.** PROPOSED.

## ADR-030 — Phone number is an optional identifier (pending legal)

**Decision.** Accounts are keyed by internal UUID with username + verified email. Phone
number is optional (contact discovery, recovery). Final design depends on whether
DoT SIM-binding directions and TIUE/MNV rules attach to phone-number use (L-02, L-03).
If they do, options are: native-app-first with SIM binding, or a product that does not use
phone numbers as identifiers — **a business decision after legal advice**.

**Status.** NEEDS-LEGAL-REVIEW.

## ADR-031 — Contact discovery

**Decision.** No bulk upload of address books in v1. Discovery by exact username, QR/invite
link, or (if phone numbers are enabled) per-number lookup with strict rate limits and
truncated-hash queries. Private contact discovery (SGX/ORAM-style) is a post-GA research item.

**Status.** PROPOSED (S-11).

## ADR-032 — Toolchain versions and substitutions (Phase 1)

**Decision.**
- **TypeScript 6.0.x**, not 7.x: typescript-eslint (typed linting, which enforces several security
  rules) supports TypeScript `<6.1`. Revisit when typescript-eslint supports TS 7.
- **ESLint 10** without `eslint-plugin-jsx-a11y` (which does not support ESLint 10); accessibility
  is enforced by axe-core assertions in component tests instead, plus manual audits (Phase 14).
  ESLint 9 was rejected because it is out of support.
- **Node.js 24 LTS** in CI and production (`.nvmrc`); `engines` allows ≥ 22.12 for local work.
- **ioredis** as the Valkey client (protocol compatible, mature); `iovalkey` is pre-1.0.
- **No `packages/config` / `packages/types`**: see [repository-structure.md](repository-structure.md).
- Dependency versions are pinned exactly (`save-exact`); install scripts are disabled by default
  (`onlyBuiltDependencies: []`); CI actions are pinned by commit SHA.

**Status.** ACCEPTED (tooling only; no open review items).

## ADR-033 — Web app and API share one origin (Phase 2)

**Decision.** The web app and the API are served from the same origin; the CDN routes `/api/*`
to the API load balancer and everything else to the static bundle. (Previously sketched as
`api.<domain>`.) The realtime WebSocket host stays separate (ticket-authenticated, ADR in
[realtime.md](realtime.md)).

**Why.** The `__Host-` session cookie is then strictly first-party and host-only; no CORS is
needed on the browser path (CORS stays configured, deny-by-default, for future origins); CSP
`connect-src 'self'` is sufficient; one fewer origin to harden.

**Trade-offs.** API and static assets share a hostname, so CDN rules must route precisely and
the API must never serve HTML. The API keeps its own restrictive CSP on every response.

**Status.** ACCEPTED.

**Amended (Phase 3).** The realtime service is also served from the web origin, at `/rt/*`
(path routing at the load balancer), instead of a separate host. Authentication is unchanged:
the socket is authenticated **only** by the single-use ticket in its first frame, never by the
cookie the browser now also sends; the Origin allow-list still applies. This keeps CSP at
`connect-src 'self'`.

## ADR-034 — Device records move to Phase 4

**Decision.** Phase 2 manages *sessions* (list, revoke, sign out everywhere). Device records,
which in this architecture are cryptographic identities (ASK-signed certificates, MLS keys —
ADR-007), are created in Phase 4 together with the keys that give them meaning.

**Why.** A device record without keys would imply a security property ("verified device") that
does not exist yet. Session management already provides "log out all devices".

**Status.** ACCEPTED.

## ADR-035 — Password, second factor and reset interplay (Phase 2)

**Decision.**
- Accounts are email-first: verify email → add first credential (passkey recommended, or
  password) → active. Passkey-only accounts are allowed.
- A user-verified passkey sign-in satisfies MFA on its own. Password sign-in requires TOTP when
  enabled. SMS is never a second factor.
- Step-up (10-minute window) guards credential and security changes; with TOTP enabled, step-up
  by password also requires a code.
- Password reset by email **still requires the second factor** when TOTP is on, so an email
  compromise alone cannot take over a 2FA-protected account. Accounts without 2FA can be reset by
  email alone (standard trade-off; documented for users).
- Lost second factor *and* recovery codes → support-assisted recovery with identity proofing and
  a waiting period (docs/authentication.md §3), **not yet implemented** (Phase 12 support tools).

**Status.** ACCEPTED (security review S-13 will re-check).

## ADR-036 — Phase 3 wire format: JSON frames, sends over REST

**Decision.** Until the MLS client exists (Phase 4), WebSocket frames are JSON validated by Zod
schemas shared between server and client (`packages/validation/src/realtime.ts`, subprotocol
`tessera.v1`). The socket is **push-only** apart from `auth`, `typing` and `ping`; message sends,
acks and sync go over the same-origin REST API (`POST /api/v1/conversations/{id}/messages` with
a client-chosen `clientMessageId` as the idempotency key). Client frames are capped at 4 KiB.

**Why.** One authorization, validation, rate-limiting and audit path for writes (the REST
pipeline already has CSRF, per-user limits and route-completeness tests); the socket carries no
state that must survive a reconnect, so it can be dropped at any time (deploys, backpressure,
network changes) without losing messages. JSON keeps Phase 3 debuggable while payloads are
still opaque bytes.

**Trade-offs.** Slightly higher send latency than a socket submit, and JSON frames are larger
than Protobuf. Revisit with ADR-020 when MLS application messages need a stable binary
plaintext format (Phase 4) and under load testing (Phase 15); the REST send path remains the
fallback either way.

**Status.** ACCEPTED (supersedes ADR-020 for WebSocket frames in Phase 3 only).

## ADR-037 — Fan-out by user channel until devices exist

**Decision.** The API publishes realtime events to one Valkey pub/sub channel per recipient user
(`<prefix>:rt:user:<userId>`); each realtime pod subscribes to the channels of the users it has
sockets for, and unsubscribes when their last socket closes. The per-device routing table of
[realtime.md §3](realtime.md) replaces this in Phase 4/5, when device records exist (ADR-034).

**Why.** Without device identities there is nothing to route to below the user; per-user
channels avoid the conversation-subscription churn rejected in realtime.md §3 while staying
O(members) per message.

**Trade-offs.** Pub/sub is fire-and-forget: a pod that misses an event leaves the client to
catch up through `sync` on its next reconnect or gap detection (sequence numbers make gaps
visible). Acceptable because the mailbox, not the socket, is the source of truth.

**Status.** ACCEPTED.

## ADR-038 — Development plaintext codec is triple-gated

**Decision.** Phase 3 needs a working chat before E2EE exists. Messages are encoded by a
`MessageCodec`; the only Phase 3 codec (`tessera-dev-plaintext-codec-v1`, ciphersuite `0`) puts
the UTF-8 JSON content into the opaque `ciphertext` field. It is enabled only when **all three**
gates are open:
1. the API sets `MESSAGING_DEV_PLAINTEXT=true` — production config validation **rejects** it, and
   the server refuses ciphersuite `0` otherwise;
2. the web app is built with `VITE_DEV_PLAINTEXT_MESSAGING=true` (`build:dev-messaging`) — the
   default build contains no codec, no chat routes and no chat navigation;
3. CI verifies the default production bundle contains none of the codec's markers
   (`verify:bundle`).
Every screen of a development build shows a permanent "not end-to-end encrypted" banner.

**Why.** Lets transport, ordering, delivery and UI be built and tested end to end now, while
guaranteeing no plaintext message path can reach staging or production (implementation plan,
Phase 3 row).

**Status.** SUPERSEDED in Phase 4: the development codec, its build and the server switch are
removed; migration 0004 deletes any ciphersuite-0 conversation and the database now rejects
ciphersuite 0.

## ADR-039 — Phase 4 implementation choices for the crypto core

**Decision.**
- **Crypto provider:** `openmls_rust_crypto` 0.6 (RustCrypto) with OpenMLS 0.9, both pinned
  exactly. Reason: pure Rust, builds for `wasm32-unknown-unknown` without C toolchains. The
  libcrux provider remains the preferred option where it covers the suite; the choice is part of
  S-01.
- **Ciphersuite:** baseline `0x0001` (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) only. The
  X-Wing hybrid suite waits on S-02.
- **Device certificate encoding:** a fixed-layout big-endian binary structure (version, user id,
  device id, MLS signature key, identity-key version, creation time, ciphersuites, Ed25519
  signature over a domain-separated body) instead of the Protobuf sketched in crypto-design §3.2.
  A fixed layout is canonical by construction: the signed bytes are the transmitted bytes, so
  there is no canonicalisation step to get wrong. The TypeScript server parser is tested against
  certificates produced by the Rust core.
- **Certificate transport:** MLS leaf-node extension `0xF0A1` (private-use range), advertised in
  leaf capabilities. Every client validates each leaf that joins or changes (KeyPackage, Welcome
  tree, Add/Update proposals and the committer's path) against the pinned identity key.
- **Application payload:** the existing versioned JSON content schema inside the MLS message,
  padded by the core to size buckets (64 B … 32 KiB powers of two, then 8 KiB steps up to 56 KiB).
  Protobuf (ADR-020) is deferred until a second client platform needs a shared binary schema.
- **Wire format policy:** handshake messages are MLS PublicMessages (signed, so the delivery
  service can order them), application messages are always PrivateMessages.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-01 (provider, handshake visibility)
and S-04 (certificate format and validation).

## ADR-040 — One encryption device per account until device linking (Phase 4)

**Decision.** In Phase 4 an account has one active encryption device. The first device creates
the Account Signing Key automatically. Signing in on another browser shows a "Set up encryption
on this device" screen; continuing creates a **new** identity key (version + 1), which:
- requires re-authentication (step-up);
- revokes every previous device and its KeyPackages;
- tells contacts, who see a blocking "security key changed" notice before they can send again;
- does not transfer history (it stays on the devices that received it).

Linking additional devices with the existing identity (QR, history transfer) is Phase 5.

**Why.** Adding a device without its user's identity key would need either server trust (the
ghost-device problem ADR-007 exists to prevent) or the linking protocol of Phase 5. A visible,
authenticated identity reset is honest and safe in the meantime.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-04 (reset UX, key-change flow).

## ADR-041 — MLS delivery on the Phase 3 mailbox

**Decision.**
- Conversations start at epoch 0 with no group. The first member device whose creating commit
  the server accepts (compare-and-set on epoch 0) owns the group; any competing device drops its
  unconfirmed group and joins by Welcome. Both "drop" operations run atomically in the crypto
  worker (a race found during E2E testing is recorded in the Phase 4 report).
- Group membership follows the key directory: any member device that notices a missing active
  device (or a revoked one) commits the Add/Remove; conflicts are resolved by the same
  compare-and-set. Devices of a contact whose identity changed are not added until the user
  accepts the change.
- Self-updates (post-compromise security) are issued after 7 days or 100 sent messages.
- **Decrypted history lives on the device** (encrypted local store); the server keeps only
  undelivered ciphertext (ADR-010). The "load earlier messages from the server" feature of Phase
  3 is removed: the server cannot provide history a device could decrypt.
- The server checks framing, epoch, membership and device ownership, but does **not** yet verify
  MLS signatures on commits (crypto-design §5 rule 2, defence in depth). Clients verify
  everything; the server-side check needs an MLS parser on the server and is tracked with S-01.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-01 (delivery-service rules).

## ADR-042 — Device linking, messages-only devices and encrypted backups (Phase 5)

**Decision.**
- **Linking by typed code.** The new device creates its device keys and an ephemeral HPKE key
  pair, publishes the public keys through `POST /keys/links`, and shows a 24-character base32
  code: the server-assigned 5-byte link id plus an 80-bit truncated SHA-256 fingerprint over
  (`tessera-link-code-v1`, link id, HPKE public key, signature public key). The existing device
  fetches the keys by link id and accepts them only if they match the fingerprint (checked when
  the code is entered and again when approving). It then seals the payload to the new device's
  key with HPKE (RFC 9180, the MLS provider's implementation, info `tessera-device-link-v1`,
  AAD = link id ‖ device id). This is the standard "authenticate a key by a short fingerprint over
  a trusted channel" pattern; the user is the channel. Codes are single use, expire after 3
  minutes, at most 3 wait per account, approval needs step-up re-authentication from an active
  device of the same account, and the payload is delivered once, only to the session that
  created the request. QR scanning (camera) is deferred; the code is also what the QR will encode.
- **Payload.** Device certificate signed by the account identity key (ASK), contact pins and
  verification states, and — only for devices given *full access* — the ASK itself and the backup
  root key. Optionally the approving device's decrypted history (JSON bundle), inside the same
  HPKE ciphertext (≤ 8 MiB). The new device checks the certificate (user, device, signature key,
  ASK version, signature) and that the ASK secret matches the account's current public key taken
  from the key directory, never from the payload.
- **Messages-only devices** hold a certificate but not the ASK: they can message but cannot link
  devices, turn on backups or back up.
- **Joining conversations.** The server publishes `keys_changed` to the account owner too; every
  member device reconciles each group against the key directory (ADR-041) and adds the new device
  (compare-and-set on the epoch settles races). Contacts see a non-blocking "added a new device"
  notice; a changed *identity* key remains blocking.
- **Removal.** `DELETE /keys/devices/:id` (step-up) revokes the device on the server; other member
  devices remove it from every group on their next reconciliation. A removed device id can never
  be registered again. A removed device that had full access still holds the ASK: the UI says so,
  and "Start over" (identity reset, ADR-040) is the remedy until ASK rotation that keeps the other
  devices exists.
- **Backups.** A random 32-byte backup root key (BRK) is wrapped with XChaCha20-Poly1305 under
  HKDF-SHA-256 of the recovery key (info `tessera-rk-wrap-v1`) or of a WebAuthn PRF output
  (`tessera-pk-wrap-v1`); AAD `tessera-backup-wrap-v1`. The backup body (ASK, pins, history
  bundle) is encrypted with the STREAM construction (Hoang–Reyhanitabar–Rogaway–Vizár; RustCrypto
  `aead::stream::EncryptorBE32`) over XChaCha20-Poly1305 in 64 KiB chunks, under
  HKDF(BRK, salt = backup id). This replaces libsodium `secretstream` from crypto-design §1 — same
  properties (per-chunk authentication, reordering and truncation detection) without adding a C
  library to the core. A JSON manifest (backup id, version, ciphertext SHA-256, size, time, user)
  is authenticated with HMAC-SHA-256 under a key derived from the BRK. The recovery key is 32
  random bytes shown once as 52 base32 characters.
- **Storage.** Backups are stored in PostgreSQL (`bytea`, ≤ 32 MiB, last 3 versions, version
  compare-and-set) until object storage arrives with media (Phase 6). The server stores only
  ciphertext, manifests, MACs and wrapped keys; adding or removing an unlock method and turning
  backups off need step-up, are audited and trigger a security email.
- **One BRK per account.** Backups are made by the device that turned them on and by devices
  linked from it with full access. A device refuses to upload when the latest backup's manifest
  does not verify under its BRK (backups were turned off and on again elsewhere).
- **Passkey unlock.** New passkeys are registered with the PRF extension. The PRF is evaluated
  with a random local challenge; the assertion is not sent to the server and the output never
  leaves the browser.
- **Limit.** 8 active devices per account, enforced by the server.

**Deferred (tracked).** Self-sync group for read state and settings (Phase 7, with groups);
signed per-device revocation and ASK rotation that keeps the remaining devices; session↔device
proof-of-possession signatures (multi-device §8); MLS external commits for restored devices;
approximate location on the approval screen; backup rollback detection (`prev_hash` is in the
manifest format but not yet filled or checked — the server could serve an older version, never
a forged one); recovery-key confirmation by re-typing groups (a checkbox confirmation is used);
media in backups (Phase 6).

**Why.** Everything uses established constructions (HPKE, AEAD, STREAM, HKDF, HMAC, WebAuthn PRF)
through audited libraries; the server can relay and store but not read or forge.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-04 (linking, device trust) and S-06
(backups).

## ADR-043 — End-to-end encrypted attachments (Phase 6)

**Decision.**
- **Encryption** (`packages/crypto-core/src/media.rs`): a fresh random 256-bit key per
  attachment; XChaCha20-Poly1305 in the STREAM construction (as backups, ADR-042) under
  HKDF-SHA-256(key, `tessera-media-v1`), 64 KiB chunks, layout `TSM1` ‖ 19-byte nonce ‖ chunks.
  The message carries `{blobId, key, plaintextSha256, ciphertextSha256, plaintextSize,
  ciphertextSize}`; decryption returns plaintext only after both hashes and sizes match (constant
  time). The worker encrypts and decrypts in 1 MiB slices, outside the MLS call queue.
- **Transport** (`services/api/src/modules/media`): the API creates a multipart upload in object
  storage (S3 API) under a random key `e2ee/<128-bit hex>`, and returns presigned `UploadPart`
  URLs (15 minutes, `Content-Length` signed) for fixed 8 MiB parts; the browser uploads directly.
  Completion checks the part list and the stored object's total size. Downloads return a 5-minute
  presigned `GET`. The API never handles blob bytes.
- **Authorization:** the sender lists the blob ids in `messaging.send` (`attachments`, ≤ 10); only
  the sender's own finished uploads can be attached, in the same transaction as the message. A
  link lives as long as the message (disappearing timers included); members of a linked
  conversation can download while the link is live; everyone else gets the same 404 as for a
  missing blob. The blob's expiry is the longest of its links; unsent uploads expire after a day;
  a sweeper deletes objects and rows.
- **Limits** (FREE tier until entitlements, Phase 13): 200 MiB per attachment (25 MiB photos),
  10 uploads in progress, 300 uploads and 2 GiB per rolling day per account.
- **Client processing:** JPEG/PNG/WebP photos are re-encoded through a canvas (drops EXIF/GPS and
  all other metadata; ≤ 4096 px); a ≤ 320 px JPEG preview (≤ 32 KiB base64) goes inside the
  encrypted message; videos get a poster frame; voice messages are recorded with MediaRecorder
  (Opus) with a 48-bar waveform. Names are sanitised (paths, control and bidi-override characters).
- **Display:** only an allow-list of image, video and audio types is rendered, from `blob:` URLs;
  everything else — including HTML, SVG and files whose decoded type does not match — is a
  download with `application/octet-stream`, and file types that can run code carry a warning.
  The sender controls the declared type, so it is never trusted for rendering.
- **Caching:** downloaded ciphertext is cached in IndexedDB (≤ 256 MiB); the key stays in the
  encrypted history.
- **Local and CI storage:** MinIO in `infra/docker/compose.yaml`; tests use the moto S3 emulator
  (`TEST_S3_URL`), which does **not** verify signatures, so expiry and signed-length enforcement
  are only asserted on the URL (and the size re-check at completion); a real S3 or MinIO run is
  required before a shared environment.

**Deferred (tracked).**
- Public/channel media pipeline (malware scan, transcoding sandbox, CSAM hashing, polyglot and
  decompression-bomb checks) → Phase 8, with the first public content; there is none yet.
- In-app document viewers on a separate user-content origin (PDF.js in a sandboxed frame) →
  with that origin's deployment (Phase 17; moved from Phase 14); documents are downloads.
- Resuming an interrupted upload after a reload (parts are retried and URLs refreshed within a
  session); forwarding attachments without re-upload; attachments inside backups (backups carry
  the keys, so restored history can open attachments while the server still has them).
- Server-side ciphertext checksum (S3 `x-amz-checksum-sha256`) at completion.

**Why.** Same reviewed construction as backups, no new primitive; the server can store and
relay but cannot read, alter undetected or enumerate attachments.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-05.

## ADR-044 — End-to-end encrypted groups: roles in the MLS group context, intent-gated adds (Phase 7a)

**Context.** Groups need roles (owner, admins, members) and settings that the server can enforce
on its own API, but a malicious or compromised server must not be able to make itself an admin,
silently add an eavesdropper, or rewrite who may post. Group names, descriptions, pins and polls
must not reach the server at all.

**Decision.**
- **Authoritative policy in MLS.** Roles and settings (`owner`, `admins`, `membersCanAdd`,
  `membersCanEditInfo`, `announcementsOnly`) are a canonical JSON `GroupPolicy` in a private-use
  **GroupContext extension `0xF0A2`**, plus a RequiredCapabilities extension so every member's
  leaf must support it. The group context is agreed by all members (it enters the key schedule)
  and reaches new members inside the signed GroupInfo of their Welcome. Only the owner creates a
  group with a policy (`crypto-core group_policy.rs`).
- **Every client authorises every commit** before merging it, against the policy in force before
  the commit: adding a *user* not yet in the group needs an admin (or `membersCanAdd`); removing a
  user needs an admin, never the owner, and only the owner removes admins — except that anyone
  may complete the removal of a user the delivery service no longer lists (left/removed); policy
  changes need an admin; role changes need the owner, or (only when the owner is no longer
  listed) an admin promoting an existing admin to owner and nothing else. Adding or removing
  *devices* of users already in the group is always allowed (governed by device certificates).
  Unauthorised commits are rejected exactly like invalid ones.
- **Server mirror.** The server keeps roles and the two server-relevant settings in
  `conversation_members.role` and `conversations.members_can_add/announcements_only` to enforce
  its API (who may add/remove/ban/link/approve, refusing members' sends in announcement-only
  groups). Clients always commit the policy first, then mirror it; if a mirror call fails or a
  re-authentication prompt is cancelled, the details panel offers "Finish saving". Clients act
  only on the MLS copy.
- **Intent-gated adds.** A malicious server can list anyone as a member. Devices therefore add a
  *new user* only when an authenticated `group_members {add}` message from someone allowed to add
  people (by the sender authority recorded at decryption time) names them, within 30 days, and no
  later `remove` intent cancels it. Creation follows the same path: the owner creates the group
  with only their own devices and every other member is added through an intent. People the
  server lists without an intent are shown to admins as "not confirmed" with an explicit
  "Confirm and add" after checking who they are.
- **Group content is E2EE.** Name/description (`group_info`), pins, polls, votes and mentions are
  ordinary encrypted content kinds. The timeline honours them only from senders whose recorded
  authority allows it (pins and moderation deletes: admins; name: admins or anyone if
  `membersCanEditInfo`). After adding people, the committing device sends a `group_info`
  *snapshot*, accepted only by members who have no name yet.
- **Invites.** Users whose privacy setting is `contacts` (default) or `nobody` receive an
  invitation instead of being added. Invite links (128-bit token, SHA-256 digest stored, expiry,
  max uses, revocable) always create a **join request** that an admin approves; the admin's device
  then sends the intent and adds the person. An optional preview title is the only group metadata
  the server can read. Auto-join (MLS external commits) is deferred to S-12.
- **Size and limits.** Group cap **256 users** (`MAX_GROUP_USERS`, server `MAX_GROUP_MEMBERS`).
  Measured natively (release, join + validation of a Welcome): 128 → 0.65 s, 256 → 1.27 s
  (Welcome 117 KiB), 512 → 2.7 s, 1,024 → 5.6 s (Welcome 470 KiB; creating it 9 s). The
  planned 1,024-member E2EE group is **not met** in the browser budget; the cap is raised only
  after profiling (ratchet-tree validation dominates). Commit and Welcome limits are 1 MiB;
  Welcomes are stored once per commit (`mls_welcome_payloads`), not once per target device.
- **Key directory.** Users may read keys and claim KeyPackages of anyone they share an active
  conversation with, 1:1 or group (previously 1:1 only), so members can verify every device.

**Consequences.** A malicious server can still delay or withhold members, drop or reorder
traffic, unlist someone (which lets any member remove them — equivalent to denying delivery),
and see group membership and roles. It cannot add a reader, change roles or settings, or read
names, pins or polls. A member who could legitimately add people can add anyone; intents within
the 30-day window could be replayed by the server to re-list someone an admin removed only via
the server (the client sends a `remove` intent on every UI removal to close this).

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-12.

## ADR-045 — Communities: server-known containers of end-to-end encrypted spaces (Phase 7b)

**Context.** Communities group many people and several conversations, need discovery, rules,
moderation and roles, and must work when no admin is online. Their *container* data (name,
description, rules, roles, member list) has to be readable by the server to list, search and
enforce it; their *conversations* must stay end-to-end encrypted.

**Decision.**
- **Container (server-protected).** `communities`, `community_roles`, `community_members`,
  `community_member_roles`, `community_bans`, `community_links` (migration 0008). Visibility is
  `public` (listed in the directory, joinable directly) or `private` (exists only for members;
  joinable through an invite link — non-members get 404 everywhere).
- **Roles.** A permission bitset (`manageCommunity`, `manageRoles`, `manageSpaces`,
  `kickMembers`, `banMembers`, `createInvites`) and a position 1–1000. A member's rank is their
  highest role (the owner outranks every role). Roles and members are managed only *below* one's
  own rank, and nobody grants permissions they do not hold. Moderation and role changes are
  written to the hash-chained audit log.
- **Verification gate,** evaluated by the server before anyone becomes a member: not banned;
  account at least *N* days old; the current rules version accepted (the join request carries
  the version the client displayed; editing the rules bumps it). Email verification is already
  required for every account.
- **Spaces are E2EE groups** (ADR-044) linked by `community_spaces`, optionally restricted to
  roles. The messaging module asks the community (via `SpaceGate`) whether someone is eligible on
  *every* path into a space (direct add, invitation, link, join request, approval). Leaving or
  being removed/banned from the community, or losing a required role, takes the person out of the
  affected spaces on the server; members' devices then remove them from the encryption group.
- **Joining a space** is a join request, approved by a space admin's device, which sends the
  encrypted membership intent and adds the person (ADR-044). For spaces marked **auto-approve**
  an admin's device does this automatically for every request the server reports, so an open
  space trusts the server's view of community membership; the UI states this, and the default is
  off. If a space owner leaves the community, server-side ownership passes to the longest-standing
  admin, whose device commits the matching takeover end to end.
- **Large rooms deferred.** Non-E2EE "large rooms" (above the 256-member E2EE cap) will reuse the
  Phase 8 channel storage and moderation pipeline rather than a second storage path now; until
  then every space is an E2EE group. MLS external commits for open spaces remain under S-12.

**Consequences.** The server knows communities, their rules, roles and members, and which spaces
exist and who is in them, but not what is said in spaces. A malicious server can admit people to
the community container and to auto-approve spaces; approval spaces still require an admin's
device to act on a request it sees. Notifications of community changes go to every member, which
is acceptable at current scale and is revisited with Phase 8 fan-out.

**Status.** PROPOSED — implemented; space membership rules under S-12.

## ADR-046 — Channels implementation: fan-out on read, sharded counters, in-process SSRF fetcher (Phase 8)

**Context.** Channels (ADR-012) are server-protected broadcast feeds that must work for audiences
of a million or more, with scheduling, polls, reactions, comments, analytics and link previews,
and without exposing per-subscriber behaviour to channel owners.

**Decision.**
- **Fan-out on read.** Publishing is one `channel_posts` insert plus an update of
  `channels.last_post_at`; subscribers fetch keyset-paginated feeds. Measured: median publish
  9.4 ms with 1,000,000 subscribers vs 11.5 ms with one, and zero writes to
  `channel_subscribers` (`channels.scale.integration.test.ts`, run with `TESSERA_SCALE_TESTS=1`).
  Open channel pages poll every 20 s; there are no per-subscriber realtime hints yet.
- **Counters.** Subscriber counts and daily joins/leaves use 16-way sharded rows (no single hot
  row); reaction counts are maintained in the same transaction as the reaction. Views are unique
  per user per post per day in Valkey HyperLogLogs, rolled up every 5 minutes into
  `channel_post_views`; owners see aggregates only.
- **Scheduling.** A singleton scheduler (Postgres advisory lock) publishes due posts with a
  compare-and-set (`status IN ('draft','scheduled') → 'published'`), so each post goes out exactly
  once even with concurrent runs; it also applies ownership transfers.
- **Ownership transfer** goes only to an existing admin, needs re-authentication, and takes effect
  after 24 hours (cancellable); the previous owner stays as a full admin. Owner-only actions and
  moderation of others' posts and comments are audited.
- **Admin roles.** Bitset (`post`, `editAny`, `deleteAny`, `manageComments`, `viewAnalytics`,
  `manageAdmins`, `editChannelInfo`); admins never grant permissions they lack, and only the
  owner changes an admin who can manage admins.
- **Link previews** are fetched only by the server, never accepted from clients, through the
  SSRF-hardened fetcher (`services/api/src/platform/safe-fetch`). It implements every rule of
  security.md §6 — https/443 only, DNS resolved once with every answer checked against the
  deny-list (private, loopback, link-local/metadata, CGNAT, multicast, documentation, reserved;
  IPv4-mapped IPv6 refused; NAT64/6to4/Teredo handled) and the connection pinned to a checked
  address, redirects re-validated (max 3), 5 s deadline, 2 MiB cap, identity encoding, HTML head
  only, fixed User-Agent, no cookies. Previews carry title, description and site name only — no
  images (privacy and SSRF surface). Results, including failures, are cached for an hour/10 min.
  **Deviation:** the fetcher runs in the API process, not as an isolated service behind an egress
  proxy; that isolation is required before the first shared environment (tracked in security.md).
- **Search.** Postgres full-text search (`simple` configuration) over published posts per
  channel; cross-channel search moves to OpenSearch later.

**Deferred.** Media in channel posts (needs the public-media scan/CSAM pipeline, Phase 11);
reports and takedown workflows (Phase 11); subscriber notifications (Phase 10); link reputation
checks (Phase 11 blocklist); realtime "channel updated" hints.

**Status.** PROPOSED — implemented.

## ADR-047 — Calls implementation: MLS-authenticated 1:1 calls, SFrame keyed per RFC 9605 §5.2 (Phase 9)

**Context.** ADR-016/017 fixed the architecture (browser WebRTC; signalling inside MLS; coturn;
LiveKit with frame encryption). Implementing them raised questions the ADRs left open: how group
media keys are derived without inventing a construction, how frames reach the SFU without
plaintext ever slipping through, what "relay for non-contacts" means when every 1:1 call is
between people who already have a direct chat, and what the server may know.

**Decision.**
- **1:1 signalling.** A `call` message kind inside the conversation's MLS messages carries
  `offer`, `answer`, `update`/`update_answer` (ICE restart) and `end`. Session descriptions carry
  every candidate (no trickle), so a call costs two encrypted messages. Receivers accept an
  answer only from the device the offer went to; the timeline builds call history from these
  messages, so history lives only on devices.
- **Fingerprint check.** The browser enforces the DTLS fingerprint of the description it was
  given; in addition, after the DTLS transport (not merely ICE) reports connected, the client
  compares SHA-256 of the certificate actually presented with the fingerprint received over MLS
  and ends the call on any mismatch, missing certificate or timeout (fail closed). A changed
  fingerprint during renegotiation is refused.
- **Relay policy.** Privacy setting `callRelay`: `always`, `unverified` (default: relay unless you
  verified the other person's safety number) or `never`. It is enforced by each device for
  itself (`iceTransportPolicy: relay` offers only relayed candidates, so the peer never learns the
  device's address). "Contacts" in the ADR-016 sense is replaced by *verified*, because every 1:1
  call already has a direct chat. The existing `calls` setting (who may call me) is enforced by the
  server.
- **TURN.** coturn's shared-secret scheme: `username = expiry:random label` (no user or device
  ID — TURN servers log usernames), `password = base64(HMAC-SHA1(secret, username))`, 10-minute
  TTL. Baseline config `infra/calls/turnserver.conf` refuses relaying to private, loopback,
  link-local/metadata, CGNAT, documentation, multicast, NAT64 and IPv4-mapped ranges (tested
  against real coturn). coturn 4.6.1 quirk: an entry `::` or a range starting at `::` also matches
  every IPv4 peer, so the IPv6 unspecified address is covered by test rather than by an entry.
- **Group-call keys: RFC 9605 §5.2, not a new construction.** Per-sender keys
  `base_key = HKDF-Expand(MLS-Exporter("SFrame 1.0 Base Key", context, 16), index, 16)` with the
  member's MLS leaf index as sender index and `KID = index << 4 | epoch mod 16`. One deliberate
  parameter choice: the exporter **context is the call ID** instead of the RFC's empty context, so
  two calls in the same epoch never share keys (and therefore never share nonces). Cipher suite
  AES_128_GCM_SHA256_128 through WebCrypto; the implementation passes the RFC's test vectors.
  Each device keeps one frame counter for all its tracks (one worker), so `(key, counter)` never
  repeats; receivers keep the last 3 epochs for the re-key overlap.
- **What stays in the clear.** Audio frames are encrypted whole. For VP8 the payload header
  (10 bytes on key frames, 3 on delta frames: frame type, version, first-partition size,
  dimensions) stays in the clear, because the SFU needs it to forward and switch layers; it is
  authenticated as SFrame metadata. Tracks are published as VP8 without RED (RED would wrap
  encrypted audio in a format the SFU parses).
- **No plaintext path.** The SFrame pipeline is plugged into the SFU client as its end-to-end
  encryption manager. In Chromium the client then creates its connections with
  `encodedInsertableStreams`, so the browser holds every frame until the pipeline is attached
  (insertable streams); elsewhere `RTCRtpScriptTransform` is used. Without either API, group calls
  are refused with an explanation. Frames that do not authenticate — including any unencrypted
  frame — are dropped, never decoded.
- **Re-key.** A commit (membership change) moves the MLS epoch; clients re-derive and switch
  immediately (commit listener plus a 5-second check). Removed members cannot derive the new
  epoch; the server also drops them from the call (sweeper → SFU `RemoveParticipant`).
- **Server knowledge.** `calls`: conversation, mode, media, initiator user and device, start,
  answer, end, end reason, peak participant count; kept 90 days
  (`CALL_RECORD_RETENTION_DAYS`). `call_participants` exists only while someone is in the call.
  The SFU sees device IDs, timing, sizes, VP8 headers and the audio-level header extension (who
  is speaking) — see S-08.

**Consequences.** SFU feature parity with LiveKit's own E2EE is not needed; we depend on the SFU
client's custom-manager hook (a documented option) and on its VP8 forwarding using only the clear
header. The audio-level extension remains visible to the SFU. The 32-participant target is a
capacity statement still to be measured with real browsers on production-like hardware.


## ADR-048 — Notifications: content-free Web Push, decryption in the service worker, one writer per device (Phase 10)

**Context.** docs/notifications.md fixed the principle (content-free pushes, decryption on the
device). Implementing it raised: how the server decides whom to wake without knowing content;
what the push service may learn; how a service worker can decrypt while a tab may also be using
the same MLS state; and how to keep user-supplied push endpoints from becoming an SSRF vector.

**Decision.**
- **Payloads.** `{t:'sync', c:<conversation>}`, `{t:'call', c, k:<call>}`, `{t:'channel', c}`,
  `{t:'alert'}`, padded to exactly 128 bytes, encrypted to the browser (RFC 8291, `aes128gcm`)
  and signed (RFC 8292 VAPID) by the `web-push` library. The `Topic` header (replacement of
  undelivered pushes) is derived per subscription (`SHA-256(auth ‖ conversation)`), so the push
  service cannot link two people's pushes about one conversation. TTL 1 h for messages, 45 s
  for calls, 24 h for alerts; urgency high for calls and alerts.
- **Who is woken (server rules).** Subscriptions belong to one session and one encryption
  device; before every push the session must be signed in and the device not revoked, and the
  sweeper deletes the rest. A session with an open realtime connection is not pushed (the gateway
  keeps `presence:session:<id>`); the open page shows its own notifications while hidden. Per
  person: message / call / channel-post switches, quiet hours (time zone, may cross midnight;
  one-to-one calls may still ring), and per-conversation mutes (a muted group does not ring for
  group calls; a one-to-one call always rings). A removed member is not woken. Channel post
  notifications are opt-in per subscription.
- **Coalescing.** A Valkey sorted set holds one entry per person and conversation/channel: due 5 s
  after the first message, and never sooner than 10 s after the previous push for that entry —
  a later message is delayed, never dropped. A singleton worker drains it; channel fan-out pages
  through opted-in subscribers in batches of 1,000. *Deviation from notifications.md §3:*
  mentions cannot bypass coalescing or mutes — the server does not know who was mentioned
  (mentions are inside the encrypted content). The device marks a notification "mentioned you".
- **Delivery and SSRF.** Endpoints must be `https` on port 443 to an allow-listed push service
  (`PUSH_SERVICE_HOSTS`: FCM, Mozilla, Apple, Windows), checked at registration and again at
  send through the SSRF-hardened POST (same address rules as the link-preview fetcher; no
  redirects; 10 s). 404/410 deletes the subscription; 10 consecutive failures delete it. A test
  origin (`PUSH_TEST_ENDPOINT_ORIGIN`) is refused in production by configuration validation.
- **Decryption on the device.** The service worker (`/sw.js`, a classic script with the same
  crypto engine) fetches the ciphertext and runs the same `ingest` as the app, then shows the
  notification per this device's setting: nothing but "New message" (default, docs/privacy.md
  §2), the conversation's name, or name and message. A
  tab that is open handles its own; if the service worker cannot decrypt (locked, no group yet,
  error), it shows "New message" — browsers require a notification per push. Titles for
  notifications are kept on the device (encrypted in the local store) by the app.
- **One writer per device.** A tab and the service worker share the device's MLS state. Only
  the holder of the device's Web Lock (`tessera-device:<user>`) may change it: a tab holds it
  while open (a second tab offers "Use here", which takes it over and stops the first); the
  service worker takes it only when free and releases it when done. As a fence against a writer
  that lost the lock mid-operation, each holder claims a new writer number in the local store and
  every commit checks it inside its IndexedDB transaction, so a stale writer cannot overwrite
  newer state. This also fixes a latent pre-Phase-10 risk: two tabs could previously fork the
  MLS state.
- **Delivered vs read.** The service worker acknowledges delivery (the sender sees "Delivered");
  messages it notified about are recorded on the device as unseen, so the app still counts them
  as unread and sends read receipts when they are read.
- **Security alerts** (docs/notifications.md §4) are stored (180 days), shown in the app on every
  device (realtime hint, Security page, navigation badge), pushed at once ignoring mutes and
  quiet hours, and still emailed. Push subscriptions follow a session through privilege-change
  rotation.

**Consequences.** Push services learn that a device was woken, when, and for which subscription
— not what for (fixed size), nor which conversation. The server learns notification
preferences, mutes and quiet hours (it must, to decide), never what a notification shows.
Delivery tests run in Chromium only here (Firefox/Safari push are untested in CI; iOS requires
the installed app). Email change and account deletion alerts arrive with those features.

## ADR-049 — Moderation: sealed report bundles, message franking, cases with legal deadlines (Phase 11)

**Context.** docs/moderation.md fixed the principles (no client-side scanning, no server
decryption, explicit reporting, due process). Implementing it raised: how a report of end-to-end
encrypted messages can be trusted when the mailbox deletes ciphertext after delivery; how
moderators reach evidence without reaching conversations; how deadlines from the IT Rules are
kept; and what an automated control may do without a person.

**Decision.**
- **Message franking** (ADR-021; the construction of Facebook Messenger's encrypted
  conversations as analysed by Grubbs, Lu and Ristenpart, CRYPTO 2017). Every message's content
  carries a fresh 32-byte key `f`; the sender sends `commitment = HMAC-SHA256(f, exact content
  JSON)` next to the ciphertext. The server stores it with the message and adds its tag:
  `HMAC-SHA256(server key, length-prefixed(context, conversation, seq, sender user, sender
  device, client message id, server time, commitment))`, as `<key id>.<base64url>` from a key ring
  (`FRANKING_KEYS`, rotatable; old keys verify). Both travel with the delivered message and are
  kept with the decrypted record on the device. A report is **content verified** only when every
  selected message has a valid server tag and its commitment opens to the reported JSON with the
  `f` inside it; otherwise **unverified** (older messages, or tampering). Nothing about franking
  is kept by the server after delivery: the tag is self-verifying.
- **Report bundles.** The reporter's device builds `{v, conversationId, reporterId, messages[],
  media[]}` from its own history: the selected messages, optionally up to 10 earlier ones for
  context (the person chooses), optionally the decrypted files of selected media messages — and
  seals it with HPKE (RFC 9180 base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM,
  `@hpke/core`) to the moderation key, info `tessera report bundle v1`, AAD `info |
  conversation | reporter`. The server opens it at ingestion (to verify and to match hashes),
  checks it matches the declared conversation, reporter and sequence numbers, and stores the
  **sealed** bytes with their SHA-256 (chain of custody). Plaintext is never stored, logged or
  indexed. Moderators open evidence through a recorded, audited view; the key is the HPKE private
  key held by the API (`MODERATION_HPKE_PRIVATE_KEY`; KMS-held in production). Public content is
  captured by the server as the reporter can see it (so a report cannot reach content its
  reporter could not read) and sealed with the server key ring.
- **Cases.** One open case per subject and category; reports, grievances, legal orders and
  automated signals attach to it. Deadlines by category: court and government orders 3 h,
  non-consensual intimate imagery and synthetic media 2 h, child abuse material acknowledge 1 h /
  resolve 24 h, threats, terrorism and self-harm 4 h / 24 h, everything else 24 h / 7 days
  (IT Rules as amended in 2026 — to be confirmed by counsel, L-05). A singleton sweeper records
  each breach once and logs an alert. Evidence is deleted one year after a case closes unless it
  is under legal hold.
- **Enforcement ladder** (moderation.md §5): warn; restrict (no new chats, or no creation of
  chats, groups, channels or invite links); suspend (signs out every session; afterwards only the
  account status, appeals, sessions and signing out are reachable — every other signed-in route
  answers `ACCOUNT_SUSPENDED`); ban; remove a public post or comment; unlist or suspend a
  channel; refer to the legal team. **Bans and legal referrals take effect only when a second
  reviewer approves** (a senior moderator, or the legal team for referrals), with step-up
  re-authentication. Every action is audited, explained to the person by email and in the app
  (reason code; internal notes are never shown), and can be appealed for 30 days to someone who
  neither took nor approved it.
- **Staff.** Roles (`moderator`, `senior_moderator`, `legal`) are granted only from the command
  line, always with an expiry ≤ 90 days, and audited (interim until the admin console with the
  corporate identity provider, Phase 12). The moderation console lives in the app for staff.
  Moderators see cases — never conversations; evidence of a case only through that case.
- **Automated controls, all without content:** new accounts (first 7 days) may start 20 chats
  and 5 groups a day, 2 channels a week and 10 invite links a day; when 3 different people report
  or 5 block someone within a day, that account cannot start new chats for 24 h and a case opens
  for a person to review. Known child abuse material is matched by exact SHA-256 (hash list
  imported by the legal role): only when a matching file is attested by a verified (franked)
  message of the sender is the sender suspended automatically and the case put on legal hold; an
  unproven match opens a priority case. Harmful link hosts are refused in public posts and
  comments, and devices warn in chats after a k-anonymous lookup (4-byte SHA-256 prefixes, then
  the full hashes of one prefix; the server never sees the link).
- **Blocks** are enforced by the server on every path: new direct chats, messages both ways,
  one-to-one calls, group adds (skipped without saying why), presence, and typing in the realtime
  gateway.

**Consequences.** The server can verify reported plaintext without ever holding plaintext of
unreported messages. A reporter can still choose what to include (selection bias); context is
optional by design. The franking commitment adds 32 bytes per message (it reveals nothing
without `f`). Exact hashing misses re-encoded media (perceptual hashing needs a licensed
list, L-12). The HPKE private key is a high-value secret: whoever holds it can read reported
evidence (only that). Behaviour signals can be gamed by coordinated reporting; their effect is
limited to a 24 h new-chat restriction and human review.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-10 (franking and report
verification); legal confirmation L-04, L-05, L-12, L-13.


## ADR-050 — Admin console: separate process, OIDC plus hardware-bound keys, RBAC with JIT elevation, four eyes, purpose binding, every call audited (Phase 12)

**Context.** docs/admin.md fixed the principles: a separate origin reachable only through the
access proxy, corporate single sign-on with hardware-backed WebAuthn, short sessions, roles with
just-in-time elevation and four-eyes approval, every data view bound to a case or ticket, no
impersonation, no secrets, no end-to-end encrypted content, and every admin call audited.
Implementing it raised: how far the admin plane is separated from the user API; how "hardware
backed" can be checked; what exactly the roles allow; how a purpose is proven; how "every call
audited" is guaranteed rather than hoped for.

**Decision.**
- **Separate process and origin.** `services/api/src/admin-server.ts` composes the same modules
  as the user API but serves only `/admin/v1/*` on its own port (`ADMIN_PORT`, default 8082;
  health on 9092), with its own origin allow-list (`ADMIN_ORIGINS`), its own CORS and CSRF
  checks, and its own session cookie (`__Host-tadm`, SameSite=Strict, HttpOnly, Secure). The
  user API serves no admin route, the admin process no user route (tested). The SPA
  (`apps/admin`) is a separate bundle with a stricter CSP than the user app (no WebAssembly,
  workers, blob: or data:, and `trusted-types 'none'`). Network reachability only through the
  identity-aware proxy is a deployment control (docs/deployment.md, Phase 15).
- **Sign-in: identity provider, then security key.** OpenID Connect authorization code with
  PKCE (S256), `state` and `nonce` (`openid-client` 6; discovery from `ADMIN_OIDC_ISSUER`); the
  flow lives server-side in Valkey under a single-use id carried by a strict cookie; the ID token
  must carry a verified email on an allowed domain (`ADMIN_EMAIL_DOMAINS`). Staff are their own
  identities (`admin_users`), not Tessera user accounts; the first sign-in binds the identity
  provider's issuer and subject to the account created for that email, and afterwards only that
  subject matches. Then a WebAuthn security key (`@simplewebauthn/server`): user verification
  required, **single-device credentials only** (the backup-eligible and backed-up flags refuse
  synced passkeys), at most five keys. With a key-model allow-list (`ADMIN_AUTHENTICATOR_AAGUIDS`)
  the key must present a `packed` attestation whose certificate chains to a configured vendor
  root (`ADMIN_ATTESTATION_ROOTS_FILE`) and names the model in its id-fido-gen-ce-aaguid
  extension; self attestation and `none` are refused. The session token is replaced when the key
  step completes. There are no admin passwords.
- **Sessions.** 8 hours absolute, 30 minutes idle (configurable only downwards); roles are read
  on every request, so expiry, revocation and disabling apply at once. Sensitive actions
  (signing a person out, approving a request, disabling an admin, removing a staff role) need a
  security-key confirmation within the last 5 minutes.
- **Roles and capabilities** (`modules/admin/rbac.ts`, table in docs/admin.md §2):
  `super_admin`, `security_admin`, `moderator`, `support_agent`, `analyst`. Every route names one
  capability; deny by default; authorization runs before the request body is parsed. Roles are
  always time-bound grants: elevated roles (super, security) at most 8 hours, others at most 90
  days. **Just-in-time elevation:** an admin made eligible (itself a four-eyes change) requests an
  elevated role for themselves; it starts when another admin approves.
- **Four eyes** (`admin_approvals`): role grants, eligibility, new admins, feature-flag changes
  and moderation staff roles are requests that a different admin with the right role approves
  within 24 hours; the person a role is for cannot approve it; the database refuses
  `decided_by = requested_by`; approval is claimed atomically, and a change that fails to apply
  returns the request to pending. Disabling an admin and removing roles take effect at once (the
  safe direction needs no second person). A break-glass operator command (`pnpm admin`)
  bootstraps the first admins; it requires the operator's name and is audited.
- **Purpose binding.** A person's account is reached only by exact email, username or id, and
  only with a purpose: `ticket:<id>` (support; an open ticket about that person), `case:<id>`
  (moderators and security; an open moderation case about that person) or
  `investigation:<reason>` (security staff and super admins; at least 10 characters). A purpose
  that does not fit both the viewer and the person answers "not found". The purpose is recorded
  with every look. What can be seen is metadata only: account status and standing, sign-in
  methods (counts and flags), devices, sessions, recent sign-ins — never message content (the
  server has none), password hashes, tokens, authenticator secrets or recovery codes. There is no
  impersonation route.
- **Every call audited.** The admin pipeline (`platform/http/admin-routes.ts`) writes an audit
  entry for every call before the response is sent — "no audit, no answer" — with the route id
  as the action, the admin, their roles, the client address, the outcome and route details
  (target, purpose); refusals (unauthenticated, forbidden, invalid, rate-limited) are audited by
  an error hook, with the caller identified before anything is refused. Alerts are logged for
  bulk lookups (more than 20 in 10 minutes), role grants, eligibility changes and disabled
  admins. The audit viewer shows security staff everything plus the hash-chain check; everyone
  else sees only their own actions.
- **Feature flags** (`modules/flags`): kill switches and staged rollouts evaluated by the user API
  (stable SHA-256 buckets per flag and person; a 15-second cache; an unknown flag is "on", so a
  flag can only switch an existing feature off or roll it out). Shipped: `link_previews`
  (security) and `group_calls` (product), wired to the link-preview fetcher and the calls
  capability. Clients read `GET /api/v1/features`.
- **Aggregates** (dashboard, sign-ups per day, failed-sign-in hotspots by network prefix) never
  name a person; daily sign-up counts below 5 are suppressed.
- **Deviation from docs/admin.md (recorded):** moderation work stays in the in-app moderation
  console for user accounts with staff roles (ADR-049); the admin console manages those staff
  roles (grant by four eyes, immediate removal) and shows moderation metrics. A billing role and
  payment tools are not built (no payments exist yet); embedded Grafana panels are replaced by
  the health checks until Phase 16 (observability).

**Consequences.** An attacker needs the corporate identity *and* the staff member's physical key,
on the admin origin; a stolen admin session expires within 30 idle minutes and cannot approve
anything without the key. A single admin cannot grant themselves power, add an admin, or flip a
flag. Support staff cannot browse: each look needs an open ticket about that person, and leaves
a trail. Without an allow-list, "single-device" is the authenticator's own claim (flags); with
one, it rests on vendor attestation, but revocation of vendor certificates (FIDO Metadata
Service) is not consulted yet. Off-hours elevated access and repeated evidence views are not yet
alerting rules (Phase 16 observability). The admin audit trail records the full client address
of staff (accountability), unlike user-facing records (prefixes).

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW S-14 (admin plane: OIDC client,
WebAuthn policy and attestation checks, authorization matrix, approval races).

## ADR-051 — Billing as built: hosted checkout, signed idempotent webhooks applied from the provider's current state, entitlements as the only interface (Phase 13)

**Context.** ADR-024 set the module split (billing owns plans, subscriptions and invoices;
entitlements answers "what may this account do") and the providers (Razorpay in India, Stripe
elsewhere). Building it raised: how to keep card data out of scope; how to make webhooks safe
against forgery, duplicates, concurrency and out-of-order delivery; how quickly a payment must
change limits; what to sell when most "premium" ideas did not exist; and how to issue invoices
that satisfy GST.

**Decision.**
- **Hosted checkout only** (Stripe Checkout sessions; Razorpay subscription links). Tessera
  stores provider references, never card or UPI data (SAQ-A). The billing country picks the
  provider and currency and is fixed while a plan runs.
- **No provider SDKs:** small adapters over the documented REST APIs, Stripe API version pinned
  (`2024-06-20`), responses validated with Zod, provider errors never forwarded.
- **Webhooks** through a new `webhook` auth kind in the route pipeline: no cookie session, no
  browser CSRF check, raw body. Verified with the providers' documented HMAC-SHA256 schemes
  (`node:crypto`, constant-time compare; Stripe's signed timestamp within 5 minutes; Razorpay's
  event id required). Each event id is inserted in the same transaction as its effect
  (idempotency), under a per-subscription advisory lock; the state applied is fetched from the
  provider inside that lock, so the order of deliveries is irrelevant. Refund totals only grow.
- **Entitlements:** `account_tiers(user, tier, valid_until, subscription)`, written by billing in
  its transaction; read through a 60-second Valkey cache that billing invalidates after commit;
  a cached tier never outlives `valid_until`. Only the subscription that granted a tier can
  remove it. Media and channels read limits through ports; the free tier equals the limits that
  existed before (nothing removed to be sold back); security and privacy features are never
  tiered.
- **States and grace:** active → until period end + 1 day; past due → 7 days from the first
  failed renewal; cancellation at period end in one step; one plan in force per account (partial
  unique index), a second paid checkout is ended at the provider and flagged for a refund.
- **GST invoices** per payment with gapless per-financial-year numbering inside the payment
  transaction; CGST+SGST within the seller's state, IGST otherwise, exports zero-rated (L-11).
- **Kill switch** `billing` (feature flag) pauses new checkouts only.
- **Admin:** the account view shows the plan (tier, status, period end, provider) — never payment
  data. Refunds and disputes are handled in the providers' dashboards and recorded from their
  events.

**Consequences.** A forged or replayed webhook cannot grant a plan; a stale one cannot revoke
it; a paid plan applies on the next request. Every webhook costs one provider API call (bounded,
retried by the provider on failure). The provider is trusted for payment truth. 1 GB is the
paid attachment limit until uploads stream (memory), not 2 GB as first proposed. Prices, SAC
code, export treatment, credit notes and refund policy await the tax adviser and counsel (L-11).

**Status.** PROPOSED — implemented; NEEDS-LEGAL-REVIEW L-11.

## ADR-052 — The web app shell as built: a signed release manifest, SRI, and a service worker that pins one verified release (Phase 14)

**Context.** e2ee.md §7 states the web code-delivery problem: the browser runs whatever code the
server sends, so a tampered or coerced deployment could ship code that reads keys. No protocol
fixes this; the mitigations reduce who can do it unnoticed and make releases auditable. Review
item S-03 asked for a signed manifest and service-worker pinning; ADR-006 already isolates keys
in a worker. Questions: what exactly is signed and by whom, what the service worker trusts on
first contact, what it does when something does not verify, and what it honestly cannot stop.

**Decision.**
- **Release manifest.** After every production build `scripts/release.mjs` writes
  `release.json`: format version, a monotonically increasing release `sequence`, version, commit,
  whether it is an official build, the keys trusted for the *next* release (the signer plus any
  announced successor, `RELEASE_NEXT_KEYS`), and the SHA-256 of every file served. It is signed
  with **Ed25519** over the domain-separated message
  `"tessera web release manifest v1\n" || manifest` (`release.json.sig`). The signing key
  (`RELEASE_SIGNING_KEY`, PKCS#8) lives only in the release pipeline; builds without it are
  signed with a throwaway key and marked `official: false`, and `RELEASE_REQUIRE_OFFICIAL=1` makes
  a missing key fatal (production pipelines). Standard primitives only — Ed25519
  (`verify_strict`, ed25519-dalek) and SHA-256, both in `crypto-core` (`release.rs`), the one place
  client cryptography lives.
- **SRI** (`sha384`) on the entry script and stylesheet in `index.html`.
- **Service worker pinning** (`apps/web/src/sw/release.ts`). The release keys and sequence are
  written into `sw.js` at build time. On `install` the worker downloads `release.json` and its
  signature, verifies it in the crypto core under the keys of the release this browser already
  runs — or, on first install only, the keys built into the worker (trust on first use) — requires
  the manifest's sequence to equal its own and not to be lower than the running one (no
  rollback), then downloads every listed file and checks its hash. Files go to a cache of their
  own per installation (`tessera-shell-<sequence>-<id>`). Any failure fails installation, removes
  that cache, and leaves the browser on the previous worker and its files. On `activate` the new
  state (cache, sequence, version, next keys) is recorded and older copies are deleted.
- **Serving.** Page loads (any same-origin navigation) and every file listed in the release are
  answered from the verified copy, with the headers (CSP) captured at install. The API, realtime,
  SFU and anything not in the release go to the network untouched. The app therefore also opens
  offline and tells the person it cannot reach the server.
- **Key rotation** is a release that lists the successor in `keys`; once installed, only the
  listed keys are trusted.
- **Monitoring.** `scripts/verify-release.mjs <origin> [--key]` checks a live deployment against
  its signed manifest (signature and every file); intended for external monitors and CI after
  deploy.
- **Settings → Account** shows which verified release a browser runs, so a person can compare it
  with the published list.

**What this does not do (stated in e2ee.md §7).** The browser fetches `sw.js` itself from the
network (`updateViaCache: 'none'`); a server that serves a *malicious service worker* replaces
the pin. This therefore defends against tampered, mixed-up or partially deployed asset files, CDN
or storage tampering of assets, and rollbacks to an older release, and it makes every release
attributable to the signing key — it does not defend against whoever controls both the origin's
`sw.js` and the signing key, nor against a first visit to a compromised server. Releases are not
yet logged to a public transparency log (Sigstore/Rekor), and builds are not yet shown to be
reproducible; both need the release pipeline (Phase 15/17). The higher-assurance answer remains
the desktop app (ADR-019).

**Alternatives.** A browser extension that verifies pages (planned, separate project); no
pinning, SRI only (protects nothing once `index.html` is replaced); trusting any key embedded in
each new worker (an attacker would embed their own — refused, tested).

**Consequences.** A deploy whose files do not match its manifest does not reach browsers that
already run Tessera (they keep the previous release), so deploys must upload files before the
manifest and `sw.js`. Losing the release signing key without a successor announced means every
browser must be reset (site data cleared) to trust a new key — the key needs the same custody as
other signing keys (Phase 15). Install downloads about 4 MB once per release.

**Status.** PROPOSED — implemented; NEEDS-SECURITY-REVIEW (S-03).

## ADR-053 — Load testing as built: a Node harness speaking the real protocol, the web client's own code for real end-to-end encryption, seeding as the only shortcut (Phase 15)

**Context.** scaling.md planned k6 for HTTP and WebSocket load with "real crypto in a smaller
fleet of headless clients". The exit criterion is the Stage-2 target (≈10,000 sockets, ≈60
messages/s at peak) with 3× headroom: 30,000 sockets and 180 messages/s, on whatever hardware the
test runs.

**Decision.**
- **A Node harness (`tests/load`) instead of k6.** k6 runs a JavaScript VM per virtual user;
  holding 30,000 mostly idle WebSockets would take tens of gigabytes. A virtual user here is a
  few kilobytes on top of its socket. The harness reuses the shared validation package for the
  protocol constants, so it cannot drift from the API.
- **Virtual users behave like the web app**, not like an idealised client: delivery acks,
  catch-up after reconnects, the app's backoff, pod failover. An early version that only sent
  and received understated API load about threefold (each message also produces two acks and
  two receipts).
- **Open-loop load** with latency histograms merged across generator processes; every run
  records CPU and memory of each service and of the machine.
- **Real end-to-end encryption through the web client's own modules** (`MessagingStore`,
  `E2eeSession`, the crypto engine and WebAssembly core), run headless in worker threads — not a
  reimplementation, so what is measured is what ships.
- **Seeding writes accounts directly to the database** (sessions stored as the API stores them);
  everything measured afterwards goes through the public interfaces. Headless clients register
  real devices and keys through the API.
- **Services run from their production builds**, as several processes ("pods"), with production
  defaults; tuning experiments pass environment overrides explicitly and are reported as such.

**Consequences.** The harness found and fixed (capacity.md §4): a presence write per user per
heartbeat that stalled delivery, a 5-second deploy drain window (design said 30 s) that let
reconnects stall sends for seconds, a shutdown race that lost presence cleanup, the default listen
backlog dropping connections in bursts, a web-client fetch per delivered message and an unhandled
rejection on failed catch-ups. Its numbers come from one 4-core machine shared by services,
database and generators — conservative, and no substitute for staging measurements with real
networks (Phase 17).

**Status.** ACCEPTED (implemented).

## ADR-054 — Deployment as built: one origin per app, generated manifests, an isolated link fetcher, least-privilege roles (Phase 17)

**Context.** ADR-023 proposed EKS behind CloudFront, Terraform and Helm. Building it showed
constraints the proposal had not met: the web app's CSP allows `connect-src 'self'` and its
session cookie is `__Host-`, so API, realtime and SFU signalling cannot live on other hostnames;
there is no Kubernetes or Terraform binary in the development environment, so anything written
must be checkable without them; and the security review required the link fetcher out of the
API process (F-05) and a release pipeline with SBOMs, signatures and provenance (F-06).

**Decision.**
- **One origin per app.** CloudFront `app.<domain>` → one public ALB routing `/api` → API,
  `/rt` → realtime, everything else → an nginx web tier that also proxies `/sfu` to LiveKit's
  signalling. The admin console likewise on `admin.<domain>` behind the access proxy and an
  internal ALB. No NLBs for WebSockets: the ALB carries them (idle timeout above the heartbeat).
- **The web tier sends the headers the build defines.** The vite configs emit
  `dist/security-headers.json` from the same `productionHeaders` that `vite preview` applies;
  `infra/images/nginx/render.mjs` turns it into the nginx configuration (adding the environment's
  media origin to `connect-src`), so one signed build serves every environment and production
  sends exactly what the end-to-end tests check. The suite runs through that configuration with
  `E2E_WEB_SERVER=nginx`. Every file the signed release manifest pins is served (the service
  worker installs only a complete release).
- **Manifests are generated, not templated.** `infra/k8s` renders each environment from typed
  definitions plus a small values file (Terraform output and release digests), in three files:
  namespaces (bootstrap, cluster administrator), prepare (configuration, secrets, policies,
  routing, the migration Job) and workloads. Tests enforce the hardening baseline and network
  isolation, boot each service's own configuration loader on the rendered production settings,
  and check every alert's runbook and metrics; CI validates against the Kubernetes schemas.
  Helm and kustomize were not used: their output could not be produced or checked here, and a
  typed generator makes the policy tests direct.
- **The link fetcher is its own deployment** of the API image (`dist/fetcher-server.js`): no data
  stores or keys, a bearer token, a concurrency limit; network policy admits only API pods and
  allows only public addresses on 443. The API treats its answers as untrusted. The "egress
  proxy" of security.md §6 is this policy plus the fetcher's own DNS pinning.
- **Least-privilege database roles** (`ops/db/roles.sql`): migrator, app (no DDL; audit log
  insert-only), realtime (three tables, read-only), readonly. The migration Job's configuration
  needs only its database URL.
- **Releases** are built once per tag (signed web release, five images with BuildKit provenance
  and SBOM attestations, Trivy gate, CycloneDX SBOMs, keyless cosign), deployed by a separate
  approved workflow that verifies every signature against the release workflow's identity,
  applies the migration Job first and waits for it.
- **Tools in workflows** are release binaries verified against published checksums (the pattern
  CI already used for gitleaks) rather than third-party actions whose commits could not be
  verified.

**Consequences.** Production serving is exercised by the end-to-end suite rather than assumed.
The Terraform and the workflows are written and statically checked but have not run against a
cloud account or a real tag — the staging bring-up is the first run (launch-readiness.md).
Open: admission policy (bootstrap), SLSA L3, a service mesh for in-cluster mTLS, automated
canary analysis, F-14 measured in staging.
