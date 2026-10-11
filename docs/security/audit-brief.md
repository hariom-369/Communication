# External assessment brief — penetration test and cryptographic audit (S-13)

Status: **ready to send** (Phase 16). This is the scoping package for the two independent
assessments the review register requires before public beta (S-13): an application/infrastructure
penetration test and a cryptographic design-and-implementation audit. They may be one firm or
two; the crypto audit needs reviewers with MLS and applied-cryptography experience.

What we want: findings with severity, reproduction and a suggested fix; a statement of what was
**not** covered; a retest of fixed findings. What we do not want: a pass/fail certificate for
marketing — no assessment result will be advertised as "military-grade" or similar.

## 1. The system in one page

Tessera is an end-to-end-encrypted messaging, calling and community platform, web-first (PWA).

| Component | Code | Notes |
|---|---|---|
| Web app (React, TypeScript) | `apps/web` | Runs the crypto core in a Web Worker (WASM); service worker pins a signed release (ADR-052) |
| Crypto core (Rust → WASM) | `packages/crypto-core` | OpenMLS for messaging; identity certificates, safety numbers, padding, media encryption, backups, device linking, release-manifest verification, franking |
| API (Fastify, TypeScript) | `services/api` | Accounts, auth (passwords with Argon2id + pepper, passkeys, TOTP), messaging mailbox (ciphertext only), keys directory, groups/communities, channels, media (presigned S3), calls (TURN credentials, LiveKit tokens), notifications (Web Push), moderation, billing |
| Admin API + console | `services/api` (`admin-server`), `apps/admin` | Separate process and origin; OIDC + single-device security key; RBAC, step-up, four-eyes, purpose binding; every call audited |
| Realtime gateway | `services/realtime` | WebSocket fan-out; single-use tickets; origin and subprotocol checks |
| Infrastructure (reference) | `infra/`, `docs/deployment.md` | PostgreSQL, Valkey, an object store with the S3 API, coturn, LiveKit |

Design and threat documents (please read first): [crypto-design.md](../crypto-design.md),
[e2ee.md](../e2ee.md), [threat-model.md](../threat-model.md), [security.md](../security.md),
[authentication.md](../authentication.md), [admin.md](../admin.md),
[privacy.md](../privacy.md) (exact server-visible metadata), [decisions.md](../decisions.md)
(ADRs), the route security matrix [route-matrix.md](route-matrix.md) (every route's
authentication, policy, rate limit and audit, generated from code), and our own review
[review.md](review.md) with the findings we already know about.

## 2. Cryptographic audit — scope and questions

In scope: `packages/crypto-core` (all of `src/`, fuzz targets), the worker boundary and encrypted
local store (`apps/web/src/crypto`), the E2EE orchestration (`apps/web/src/messaging/e2ee.ts`,
`store.ts`), call keying (`apps/web/src/calls`), the service-worker release pinning
(`apps/web/src/sw`), and the server paths that relay key material
(`services/api/src/modules/{keys,messaging,backups,moderation}`).

Questions we most want answered (register items):

| Item | Question |
|---|---|
| S-01 | Is our use of OpenMLS correct — ciphersuite and provider choice, PublicMessage handshakes, how the delivery service orders commits, Welcome handling, epoch/retention settings? |
| S-02 | Is the post-quantum plan (X-Wing hybrid, migration) sound given the draft status? |
| S-03 | Are the browser-side claims honest: WASM in a worker, IndexedDB at-rest encryption, signed-manifest service-worker pinning and its stated limits (e2ee.md §7)? |
| S-04 | Can a malicious server add a ghost device or substitute an identity without the user being told? Certificate format, cross-signing, trusted/untrusted devices, safety numbers, key-change UX |
| S-05 | Media encryption construction (per-file key, STREAM), metadata, blob ↔ conversation linking |
| S-06 | Backup key hierarchy, passkey-PRF wrapping, rollback detection |
| S-08 | Group-call E2EE: SFrame keying from the MLS exporter, what the SFU sees, re-key timing |
| S-10 | Message franking for abuse reports: does a report prove what was sent without revealing anything else? |
| S-12 | Group policy in the MLS group context and client-side commit authorisation; external commits for open spaces |

Constraints we hold ourselves to and want checked: no custom cryptographic protocols or
primitives; the server never holds keys that decrypt private messages; no plaintext message
content indexed or logged server-side.

## 3. Penetration test — scope

In scope: the user web app and API, the realtime gateway, the admin console and admin API, the
media upload/download flow, call signalling and TURN credential issuance, Web Push subscription
handling, billing webhooks, and the reference deployment once staging exists (Phase 17).
Authenticated testing with several user accounts per role (member, group admin/owner, community
admin, channel owner) and admin accounts per staff role, provided on request.

Areas of particular interest: authorization on every object ID (IDOR) — the matrix lists each
route's policy; session handling (cookie, CSRF header, step-up, revocation reaching open
sockets); rate-limit and abuse controls, including shared-address (CGNAT) behaviour; SSRF via the
link-preview fetcher and push endpoints; upload handling and content types; the admin plane's
step-up, four-eyes and purpose binding; webhook signature handling; realtime ticket replay and
cross-user frame delivery; denial of service by legitimate-looking load (capacity.md §4 lists the
known limit after a realtime pod crash).

Out of scope unless agreed: volumetric DDoS, social engineering of staff, physical attacks, the
third-party providers themselves (payment, push services, identity provider), and findings that
require a compromised end-user device.

## 4. Environment and rules of engagement

- A dedicated staging environment (Phase 17) with production configuration, synthetic data only,
  and its own keys. No production user data is ever made available.
- Source access: the repository (read-only) and these documents; we answer design questions
  directly.
- Test accounts, admin accounts (with their security keys) and an allow-list of the testers'
  source addresses for the edge rate limits.
- Reporting: critical findings immediately to the security contact (see SECURITY.md); others in
  the report. We fix critical and high findings before public beta and retest them.

## 5. Deliverables

1. Report with findings (CVSS 4.0 or the firm's equivalent, reproduction, fix), coverage
   statement, and methodology.
2. Retest letter after fixes.
3. For the crypto audit: answers to the questions in §2, including "we did not examine X".
