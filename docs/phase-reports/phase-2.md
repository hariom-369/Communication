# Phase 2 report — Accounts, authentication, sessions

**Status: GREEN** (locally verified 2026-09-28; CI has not run because the branch still cannot be
pushed — GitHub returns 403 for the Claude app).

## Results

| Gate | Result |
|---|---|
| Format, lint (typed, strict, security rules), typecheck, build | pass |
| Unit tests | **199 passed** — api 108, ui 59, platform 15, web 7, shared 7, validation 3 |
| Integration tests (real PostgreSQL + Valkey) | **52 passed** |
| End-to-end (Chromium, production build, strict CSP, real API/DB/SMTP) | **10 passed**, run 3× without flakes |
| Mutation checks of security controls | 7 of 7 mutations caught (after fixing one weak test — see below) |
| OpenAPI | 28 paths, regenerated and committed |
| `pnpm audit` / secret scan | no known vulnerabilities / no leaks |

## Delivered

**API (`services/api`)**
- `accounts` module: email-first sign-up (18+ declaration, terms version recorded), 6-digit
  email codes (hashed, single latest code valid, 5 attempts, 15-min TTL), anti-enumeration
  responses (existing emails get a notice, not a code), username rules (reserved names, ASCII
  only), privacy settings (validated, protective defaults).
- `auth` module: Argon2id (m=64 MiB, t=3) over HMAC-pepper(NFKC(password)), zxcvbn strength
  (score ≥ 3, no own identifiers), rehash-on-login, constant-work path for unknown accounts;
  WebAuthn passkeys (UV + resident key required, attestation none, single-use challenges via
  Valkey GETDEL, counter tracking); TOTP (RFC 6238, ±1 step, replay-protected); 10 single-use
  recovery codes; MFA stage; step-up re-authentication (10 min; with TOTP on, password step-up
  also needs a code); password reset via URL-fragment token (30 min, single use, signs out all
  sessions, still requires 2FA when enabled); sessions (list, revoke, revoke others, logout);
  new-sign-in alerts and security notices by email.
- Sessions: `__Host-tsid` (Secure, HttpOnly, SameSite=Lax, host-only), 256-bit tokens stored as
  SHA-256; stages `credential_setup` (30 min) → `mfa_pending` (5 min) → `active` (30 d idle /
  90 d absolute); **rotated on every privilege change**.
- `audit` module: append-only (DB trigger), SHA-256 hash-chained, written in the same
  transaction as the change; chain verification.
- Pipeline: session authentication, stage and step-up enforcement, per-user route limits for
  signed-in users, IP flood guard, per-identifier/session limits that fail closed.
- Architecture tests: module boundaries **and table ownership** (modules may only query their
  own tables).

**Web (`apps/web`)** — sign-up → verify → create passkey or password; sign-in with passkey or
password (+ TOTP / recovery code); forgot/reset password; Security (passkeys, password, two-step
verification with QR + recovery codes, sessions), Privacy, Account. Step-up dialog on demand.
Loading skeletons, empty/error/offline states, focus management, skip link, light/dark,
reduced motion, responsive (mobile top bar, desktop rail). Production build has no inline
script/style and runs under `script-src 'self'` + Trusted Types.

## Defects found and fixed during this phase

1. **Per-IP rate limits blocked legitimate users behind shared IPs.** E2E users (one IP) were
   locked out after ~10 accounts — the same would happen to users behind carrier-grade NAT,
   which is common on Indian mobile networks. Fixed: signed-in routes are limited per user; a
   generous per-IP flood guard applies to all routes; public-route IP limits raised, strict
   per-identifier limits unchanged. Regression test added (25 users behind one IP).
2. **A passkey test passed for the wrong reason.** The "no user verification" case used an
   unregistered authenticator, so it failed on "unknown credential" and never exercised the UV
   check; a mutation disabling UV enforcement survived. Test fixed; mutation now caught.
3. **Welcome state lost** after credential setup (route guard redirected first) — fixed by making
   the guard own that transition.
4. **Heading focus on first load** stole the first Tab from the skip link — focus now moves only on
   in-app navigation.
5. **Text outside landmarks** on signed-out pages (axe) — moved into `<footer>`.

## Security implications reviewed

New attack surface: 28 endpoints (22 auth, 6 accounts). Threat-model entries addressed in code:
T-02 (session theft: HttpOnly host-only cookie, rotation, revocation), T-09/T-10 (phishing and
account takeover: passkeys first, no SMS 2FA, breach-resistant hashing, per-identifier limits,
new-sign-in alerts), T-12 (SIM swap: phone not used), T-14/T-15 (XSS/CSWSH groundwork: strict CSP
verified in a real browser), T-24 (replay: WebAuthn challenges, TOTP steps, recovery codes,
reset tokens all single use), T-06 (DB leak: only digests/hashes/ciphertext of secrets — verified
by tests).

Residual risks / open items:
- Email is the account-recovery root for accounts **without** 2FA (documented trade-off, ADR-035).
- TOTP secrets use an application keyring (AES-256-GCM); KMS envelope encryption is planned.
- No CAPTCHA/risk-based challenge yet (Phase 11); no breached-password corpus lookup yet (zxcvbn
  dictionaries only) — tracked for Phase 11.
- Support-assisted recovery (lost 2FA and recovery codes) not implemented — Phase 12.

## Known gaps (explicitly not done)

- **Push still blocked (HTTP 403)**; CI has never run on GitHub.
- Phone numbers, SIM binding, MNV: waiting on L-02/L-03.
- Device records: Phase 4 (ADR-034).
- Account deletion and data export: planned with the privacy center completion (Phase 11/12
  per plan; DPDP obligations apply from ~May 2027).
- OpenTelemetry metrics/traces and container images: still pending from Phase 1.

## Next phase

Phase 3 — core messaging + WebSocket realtime service (payloads opaque from day one; E2EE in
Phase 4).
