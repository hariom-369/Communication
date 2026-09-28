# Phase-by-phase implementation plan

Status: PROPOSED. Each phase ends with the **phase exit protocol**:
1 run tests · 2 typecheck · 3 lint · 4 build · 5 inspect errors · 6 fix · 7 update docs ·
8 verify security implications (threat-model delta) · 9 commit · 10 report exact status.
**No phase starts while the previous one is red.** Every phase begins by re-reading the
primary sources marked [K] in [research-sources.md](research-sources.md) that it depends on.

## Definition of Done (per feature)

UI (with loading/empty/error/offline states, a11y) + API (versioned, schema-validated) +
database (migration, indexes) + authorization (policy + tests) + validation + error
handling (problem+json) + security review notes + tests (unit/integration/E2E as
appropriate) + logging/metrics + documentation. A feature with only UI is **not done**.
Features not yet built are absent from the UI — no "coming soon" stubs.

## Phases

| Phase | Scope | Key exit criteria | Blocking reviews |
|---|---|---|---|
| **0** Research & architecture | This package | Architecture reviewed; ADRs accepted or amended; review register triaged | S-01 scheduled; L-02/L-03 answered or accepted as risk |
| **1** Repo, tooling, CI/CD — **DONE** ([report](phase-reports/phase-1.md)) | Monorepo (pnpm + Turborepo), strict TS, ESLint with security rules, Prettier, Vitest; `packages/platform` (validated config, allow-list logger, AppError, health server, lifecycle); API pipeline (security headers, CSRF, CORS, problem+json errors, request IDs, body limits, proto-poisoning defence, GCRA rate limiting on Valkey with degraded mode, route registry + completeness test, module-boundary test, OpenAPI generation); forward-only migration runner; design-system tokens + primitives; local compose; CI (verify, integration, secret scan, OSV, dependency review, CodeQL); governance files. **Moved:** web app shell + Playwright → Phase 2 (first real screens); Rust/cargo toolchain → Phase 4 (first Rust code); realtime service → Phase 3; Terraform → before first shared environment (Phase 2 exit); SBOM/image signing → with the first container image (Phase 2) | CI green; `/livez` `/readyz` `/startupz`; route completeness, module boundary and log-leak tests active | — |
| **2** Auth, accounts, sessions — **DONE** ([report](phase-reports/phase-2.md)) | Email-first sign-up (18+ declaration, terms version), email verification, passkeys (WebAuthn, UV required), Argon2id+pepper passwords with strength checks, TOTP with replay protection, recovery codes, MFA stage, step-up re-authentication, password reset (2FA still enforced), sessions (list/revoke/others/logout), new-sign-in and security notices, privacy settings storage, hash-chained audit log, CGNAT-aware rate limits; web app (sign-up, verify, credential setup, sign-in + MFA, reset, Security/Privacy/Account settings) under strict CSP; E2E. **Moved:** device records → Phase 4 (ADR-034); phone numbers wait on L-02/L-03; support-assisted recovery → Phase 12 | Auth security suite green (52 integration, 10 E2E); mutation-checked controls; axe clean | L-02/03 (phone, deferred), L-06 (18+ declaration implemented; VPC design outstanding) |
| **3** Core messaging + WebSocket — **DONE** ([report](phase-reports/phase-3.md)) | Conversations, mailbox, seq/idempotency, realtime gateway (tickets, origin, fan-out, heartbeat, backpressure), delivery states, sync, pagination, message ops (reply/react/edit/delete), disappearing timers, presence/typing, chat UI (desktop 4-pane, mobile). **Payloads are opaque bytes from day one**; Phase 3 uses the Phase-4 crypto API behind a feature flag in dev only — no plaintext message path is ever deployed to staging/prod (ADR-038: triple-gated development codec, bundle check in CI). **Moved:** groups → Phase 7; per-device cursors/routing → Phase 4/5 (ADR-037); persisted encrypted outbox → Phase 4; reconnect-storm load test → Phase 15 | Delivery semantics tests; reconnect storm test; no plaintext storage path exists (verified by schema: `ciphertext bytea` only) | — |
| **4** E2EE foundation — **DONE (pending review)** ([report](phase-reports/phase-4.md)) | crypto-core (OpenMLS, WASM, worker), ASK + device certs, KeyPackages, 1:1 MLS groups, safety numbers/QR, key-change warnings, encrypted local store, padding. **Moved:** additional devices / linking → Phase 5 (ADR-040: one device per account, identity reset); QR comparison → with device linking; last-resort KeyPackage rotation and server-side commit signature checks → before public beta (tracked in crypto-design §0) | Crypto test suite; malicious-server fixtures; fuzzing running; external crypto review started — **review package ready, review not yet contracted** | **S-01..S-04 must be signed off before Phase 5 ships to users** |
| **5** Multi-device E2EE — **DONE (pending review)** ([report](phase-reports/phase-5.md)) | Device linking by code (HPKE, fingerprint-checked), full-access and messages-only devices, device list/removal, 8-device limit, history transfer, encrypted backups (recovery key + passkey PRF), restore, local search over on-device history, new-device notices. **Moved:** self-sync group → Phase 7; QR scanning → with camera-capable clients; ASK rotation keeping devices, signed revocations and session↔device signatures → before public beta; backups to object storage → Phase 6 (ADR-042) | Device-sync suite; backup restore tests (recovery key, passkey, tamper, wrong key, older identity); E2E linking/restore | **S-04, S-06** |
| **6** Media | Presigned multipart, client encryption, thumbnails, viewers on user-content origin, voice notes, documents, public-media pipeline (scan/transcode sandbox) | Media suite; sandbox egress test | S-05 |
| **7** Groups + communities | Group roles/policy, invites, join requests, bans, pins, announcements, polls, mentions, ownership transfer; communities, roles, spaces, discovery, verification gates, large rooms | Permission matrix; concurrency tests; 1,024 perf test | S-12 |
| **8** Channels | Channels module, posts, scheduling, comments, reactions, analytics, discovery, SSRF-safe link previews | 1M-subscriber synthetic publish; SSRF suite | — |
| **9** Voice/video | 1:1 calls with MLS-authenticated fingerprints, TURN, LiveKit + SFrame group calls, screen share, device switching, call history | Fingerprint-substitution test; unsupported-browser refusal | S-08 |
| **10** Notifications | Web push (content-free), SW decryption, email alerts, prefs, coalescing | Push delivery tests across browsers; no content leaves server | — |
| **11** Moderation/security | Reports (incl. E2EE explicit flow), cases, enforcement ladder, appeals, evidence, spam/flood/new-account controls, link blocklist, grievance & takedown SLA workflows, CSAM pipeline for public media | Abuse suite; SLA timer tests | S-10, L-04, L-05, L-12, L-13 |
| **12** Admin | Admin SPA + API, SSO/WebAuthn, RBAC, JIT elevation, 4-eyes, audit viewer, health dashboards, feature flags | Admin authz matrix; audit completeness | — |
| **13** Billing | Plans, providers (Razorpay/Stripe), webhooks, entitlements, invoices, cancellation | Webhook idempotency; entitlement propagation | L-11 |
| **14** PWA/web optimisation | Installability, offline shell, background sync where supported, performance budgets, reduced motion, a11y audit, signed release manifest & SW pinning | Lighthouse/Web Vitals budgets; WCAG 2.2 AA audit | S-03 |
| **15** Load testing | k6 + headless crypto clients; capacity model; tuning | Stage-2 (100k) targets met with 3× headroom | — |
| **16** Security audit prep | ASVS L2/L3 assessment, threat-model refresh, external pentest + crypto audit, fix findings, bug-bounty prep, SECURITY.md | No open critical/high findings | S-13 |
| **17** Production deployment | Prod infra, DR drill, runbooks, on-call, compliance sign-offs, staged beta rollout | DR restore test passed; legal sign-off; launch gates in [prd.md §9](prd.md) | All L-items for launch |

## Sequencing notes

- Phases 10–12 are **launch prerequisites**: a public platform without moderation, grievance
  handling and admin tooling cannot launch lawfully or safely. Channels (8), calls (9) and
  billing (13) may follow public beta if the business prefers an earlier beta.
- The external cryptographic review (S-01..S-06) is the critical-path dependency; it
  should be contracted during Phase 1 so reviewers are available at Phase 4.
- Design system work runs in parallel from Phase 1 (original identity; not a template).

## Reporting format after each phase

```
Phase N — <name>: GREEN | RED
Tests: <passed>/<total> (unit, integration, e2e); Typecheck: ok; Lint: ok; Build: ok
Security: threat-model delta <link>; new review items <ids>
Docs updated: <files>
Known gaps (explicitly not done): <list>
Commit: <sha>
```
