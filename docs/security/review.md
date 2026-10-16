# Internal security review (Phase 16)

Status: **complete for Phase 16**; the external assessments (S-13, [audit-brief.md](audit-brief.md))
follow in staging. Method: every claim in [security.md](../security.md),
[authentication.md](../authentication.md) and the threat model checked against the code; every
route reviewed through the generated [route matrix](route-matrix.md) with its invariants enforced
by a test; the scanners available here run (§3); the ASVS 5.0 assessment in [asvs.md](asvs.md).
Severities: CVSS 4.0-style judgement — **critical** (remote compromise of message content, keys or
accounts at scale), **high** (one account or the admin plane), **medium** (a missing layer of
defence, or a documented control that is absent), **low** (hardening).

## 1. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | low | security.md §4 claimed a lint rule against string-built SQL; none existed (the code had no such SQL) | **fixed** — Kysely's unparameterised escape hatches (`sql.raw`, `sql.lit`) are lint errors |
| F-02 | low | The CI dependency scan covered `pnpm-lock.yaml` only, not the crypto core's `Cargo.lock` | **fixed** — OSV scans both |
| F-03 | low | Presigned downloads did not pin response headers (objects are stored as `application/octet-stream`, so no exploit today) | **fixed** — the signature pins `application/octet-stream` and `attachment` (integration test) |
| F-04 | medium | authentication.md promised a breached-password check; only the strength estimator's common-password lists existed | **fixed** — range-API mirror check on every new password, required in production (unit + integration tests, mutation-checked) |
| F-05 | medium | The SSRF-protected link-preview fetcher runs inside the API process; security.md requires isolation with its own egress before a shared environment | **fixed in Phase 17** — its own deployment with no data stores or keys, network policy (only the API in, only public 443 out), required in production, answers validated as untrusted (tests, mutation-checked; policy test) |
| F-06 | medium | security.md §10 and T-17/T-19/T-20 describe SBOMs, image scanning and signing, SLSA provenance, reproducible builds, a release transparency log and `cargo deny`; none is built | **fixed in Phase 17** for SBOMs, scanning, signing with verification at deploy, provenance and `cargo deny` (release.yml, deploy.yml, deny.toml); still open, stated in security.md §10: cluster admission policy (bootstrap), SLSA L3, reproducible builds, transparency log |
| F-07 | medium | An API process exited when a background job could not get a database connection (unhandled rejection); found by the Phase 15 soak | **fixed** in Phase 15 (unit test fails on the old code) |
| F-08 | low | Literal bidirectional-override characters inside a validation regex ("Trojan Source" style — invisible in review) | **fixed** — written as `\u` escapes; no source file contains such characters |
| F-09 | medium | No risk-based challenges (CAPTCHA-style), credential-stuffing detection or risk-triggered MFA prompts (T-10, T-16) | open → before public beta (moved from Phase 11; needs a provider and a privacy decision) |
| F-10 | low | testing.md promises XSS payloads in every user-controlled field; only message text was tested | **fixed** — E2E test for group names, file names, channel titles and posts |
| F-11 | **high** | Adding a passkey to an active account needed no re-authentication: a stolen session could register its own passkey and survive sign-out and a password change (the web UI already asked for step-up; the API did not enforce it) | **fixed** — `stepUp: 'when-active'` on both registration routes; matrix invariant for every factor-adding route (integration test, mutation-checked) |
| F-12 | medium | The bare-domain regex used for link checks (API and web) was quadratic: 64 KiB of `a.a.a…` blocked the event loop for 4 s, per request | **fixed** — linear scan in `@tessera/shared` (timing test) |
| F-13 | medium | Message references in decrypted content were any string, so a peer could address `__proto__` and corrupt or crash the recipient's timeline state; server-sent sender/device/message ids were unvalidated strings too | **fixed** — all validated as UUIDv7 (regression test) |
| F-14 | medium | A realtime pod crash slows connected users' sends for ≈ 20 s on the test machine while its clients reconnect (capacity.md §4) | mitigated in Phase 17 by sizing (10–12k sockets per pod, N+1, infra/k8s); measuring API headroom needs staging → open until then |
| F-15 | medium | Live delivery runs over Valkey pub/sub: after a Valkey loss, events published during the outage were gone and connected clients had no reason to catch up — 3,902 of 12,000 deliveries never arrived in the Phase 17 drill (messages were stored, but unseen until the next reconnect) | **fixed in Phase 17** — a realtime pod whose subscription returns after a loss asks every connection to reconnect with jitter, so clients run their catch-up (integration test, mutation-checked; re-run drill: 0 missing; docs/dr-drills/2026-10-16.md) |

**Open critical or high findings: none.** Open medium findings are scheduled with a phase and are
listed again in the Phase 16 report. F-15 was found by the Phase 17 Valkey-loss drill.

## 2. Route review

The [route matrix](route-matrix.md) lists all 214 user-API and 30 admin routes. Reviewed:

- **Unauthenticated routes (12):** sign-up, e-mail verification and its resend, password and
  passkey sign-in, password reset (request, complete), the build version, the public grievance
  form, and two payment webhooks. Every one except the webhooks fails closed when the limiter
  store is down; the webhooks are authenticated by the provider's signature and fall back to a
  per-process limit (refusing them would only make the provider retry).
- **Step-up:** credential and factor changes, device revocation and link approval, identity
  reset, backup keys, deletion and ownership transfer of groups, communities and channels,
  and the moderation actions that need four eyes. **Adding a passkey was missing (F-11).**
- **Admin routes without a capability (6):** the sign-in steps after OIDC, sign-out, the
  caller's own profile and re-authentication. **Admin routes without a session (2):** the OIDC
  start and callback, both failing closed.
- **GET never changes state:** no GET route writes audit records (GET skips the CSRF checks).

These are now invariants in `services/api/src/security-matrix.test.ts`: a new route in one of
these categories fails the test until it is reviewed and added to the list.

## 3. Scanners

| Tool | Scope | Result |
|---|---|---|
| ESLint with the repository rules | all TypeScript | clean (after F-01) |
| `eslint-plugin-security` 4.2 + `eslint-plugin-no-unsanitized` 4.1 (one-off configuration, not committed) | apps, services, packages, tests — 462 files | 248 messages: 7 possibly unsafe regexes (one real — **F-12**; six anchored, bounded or build-time), 5 bidi characters (**F-08**), 139 object-injection sinks (82 in product code: the ones keyed by other parties' data are **F-13**; the rest key by internal constants, enum values or the user's own input — sampled, not read one by one), 53 file paths and 32 regexes from variables (tests, scripts and operator configuration only), 2 "timing attacks" (client-side comparisons of non-secrets), 0 unsanitized DOM sinks |
| `pnpm audit` | npm dependencies | no known vulnerabilities |
| gitleaks 8 | full git history and every committed file | no leaks (one false positive in prose: the commit was amended and re-pushed within a minute) |
| CodeQL, OSV (npm + Cargo), dependency review | CI | run on every push / pull request; OSV and RustSec are not reachable from this environment |
| Header and cookie checks | API (`app.test.ts`), web (CSP in E2E), admin (integration) | as specified in security.md §3 |

## 4. Not covered here

- Penetration testing of a deployed environment (TLS, load balancer, WAF, cloud IAM) — staging,
  Phase 17, and the external test (S-13).
- Cryptographic review of the protocol use and of `packages/crypto-core` — the external crypto
  audit (S-01..S-12); this review only checked that the code matches the documents.
- Dependency advisories for Rust crates could not be queried from this environment (the OSV and
  RustSec databases are not reachable); CI's OSV scan covers `Cargo.lock` from this phase on.
