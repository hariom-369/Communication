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

**Status.** PROPOSED.

## ADR-017 — Group calls

**Decision.** Self-hosted **LiveKit** SFU (Apache-2.0). Media frames E2EE-encrypted in the
browser via WebRTC Encoded Transform, using SFrame (RFC 9605) with keys derived from the
conversation's MLS exporter secret (`MLS-Exporter("tessera call", callId, 32)`), re-keyed
on membership change. SFU sees only encrypted frames plus RTP headers/metadata.

**Alternatives.** mediasoup (library, more build effort); Jitsi (Java stack, heavier).
Browser support gaps for encoded transforms → calls without E2EE are **not** silently
allowed; unsupported browsers are blocked from E2EE calls with an explanation.

**Status.** NEEDS-SECURITY-REVIEW (S-08).

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

**Status.** NEEDS-SECURITY-REVIEW (S-10).

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
  Phase 14; documents are downloads.
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
