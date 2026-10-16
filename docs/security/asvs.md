# OWASP ASVS 5.0 assessment (Phase 16)

Target ([security.md](../security.md)): **Level 2** for every component; **Level 3** for
authentication, session management, cryptography and the admin plane. This is a self-assessment by
the development team at the level of ASVS chapters and their control areas, with the code and the
tests that are the evidence. It is the input to the external assessment (S-13,
[audit-brief.md](audit-brief.md)), which verifies it requirement by requirement against the
official ASVS 5.0 text — requirement numbers are deliberately not quoted here, so nothing in this
document can be mistaken for that verification.

Status: **Met** — implemented and tested; **Partial** — implemented with a stated gap;
**Gap** — not implemented (a finding in [review.md](review.md)); **N/A** — not applicable, with
the reason. Findings referenced as F-nn.

## V1 Encoding and sanitization

| Area | Status | Evidence |
|---|---|---|
| Output encoding in the browser | Met | React escaping; `dangerouslySetInnerHTML`, `eval`, `new Function` are lint errors (`eslint.config.js`); rich text rendered from a parsed AST; strict CSP with Trusted Types (`apps/web/vite.config.ts`); XSS payloads in every user-controlled field the UI renders are checked end to end (F-10: was messages only) |
| Injection: SQL | Met | Kysely query builder and `sql` tagged templates only (bound parameters); Kysely's raw escape hatches are lint errors (F-01) |
| Injection: OS command, LDAP, XPath, template | N/A | no shell, LDAP, XPath or server-side templates on request paths |
| Safe deserialisation | Met | JSON only; `__proto__` / `constructor` keys rejected (Fastify poisoning options), unknown keys rejected (strict Zod objects); ids arriving from peers and the server validated as UUIDv7 before they key client state (F-13) |

## V2 Validation and business logic

| Area | Status | Evidence |
|---|---|---|
| Input validation | Met | every route has a Zod schema for params, query and body (`defineRoute`), response schemas too; OpenAPI generated from them |
| Business logic limits | Met | per-route rate limits on every route (route matrix), per-recipient and new-account limits (moderation.md §0), quotas for media, devices (8), group size (1,024); no super-linear regex on user input (F-12 fixed) |
| Anti-automation | Partial | rate limits keyed per account and per identifier, CGNAT-tolerant flood guard; **no CAPTCHA-style challenge or risk scoring (F-09)** |

## V3 Web frontend security

| Area | Status | Evidence |
|---|---|---|
| Content Security Policy, Trusted Types | Met | strict CSP without `unsafe-inline`/`unsafe-eval` (only `wasm-unsafe-eval` for the crypto worker), one Trusted Types policy; admin SPA forbids WebAssembly, workers, `blob:` |
| Other headers | Met | COOP, CORP, nosniff, `Referrer-Policy: no-referrer`, Permissions-Policy, frame-ancestors none (`platform/http/security-headers.ts`; unit-tested in `app.test.ts`, CSP checked end to end) |
| Cookies | Met | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax` (user) / `Strict` (admin) |
| Browser storage | Met | no tokens or content in Web Storage (lint-enforced); IndexedDB contents encrypted by the crypto worker |
| Subresource integrity, code delivery | Partial | SRI and a signed release manifest pinned by the service worker (ADR-052); the first visit trusts the server — stated in e2ee.md §7 |
| Cross-origin resources, open redirects | Met | no user-controlled redirects; links limited to `https:`/`mailto:` with `noopener noreferrer` |

## V4 API and web service

| Area | Status | Evidence |
|---|---|---|
| HTTP methods, content types | Met | per-route method; JSON only (`application/problem+json` errors); webhooks take the raw body for signature checks only |
| CORS | Met | explicit origin allow-list, credentials only for it, strict preflight (`app.ts`) |
| CSRF | Met | custom header + Origin allow-list + `Sec-Fetch-Site` rejection (`platform/http/csrf.ts`); GET never changes state (route-matrix invariant) |
| WebSocket | Met | single-use 30 s ticket, `Origin` allow-list, subprotocol, schema-validated frames, backpressure, session recheck closes revoked sessions (`services/realtime`, 19 integration tests) |
| GraphQL | N/A | none |

## V5 File handling

| Area | Status | Evidence |
|---|---|---|
| Upload | Met | presigned multipart with signed per-part length; server-set object key and content type; quotas; abandoned uploads swept |
| Download / serving | Met | ciphertext only; presigned GET pins `application/octet-stream` + `attachment` (F-03); decrypted files rendered inline only for an allow-list of media types (ADR-043) |
| Malicious files | Partial | the server cannot inspect E2EE files by design; known-abuse media matched by exact hash for public content (moderation.md); perceptual hashing deferred with L-12 |

## V6 Authentication — target Level 3

| Area | Status | Evidence |
|---|---|---|
| Password storage | Met | Argon2id with a KMS-held pepper (HMAC-SHA-256 before hashing), parameter upgrade path (`modules/auth/passwords.ts`) |
| Password policy | Met | 12–128 characters, Unicode, no composition rules, strength estimate (zxcvbn ≥ 3, own identifiers refused) **and a breached-password check against a range-API mirror (F-04, new in Phase 16)** |
| Multi-factor | Met | passkeys (user verification required, resident keys), TOTP with replay protection, single-use recovery codes stored as SHA-256 digests |
| Brute force | Met | per-identifier and per-IP limits that fail closed, soft time-based lock (no lockout DoS), uniform timing for unknown accounts (unit-tested, mutation-checked) |
| Account recovery | Partial | email reset requires the second factor if one is enrolled; reset signs out all sessions. Support-assisted recovery is deferred (identity proofing decision) |
| Credential changes | Met | step-up within 10 min for every credential and factor change — including adding a passkey (F-11, fixed in Phase 16); security alerts on every device; audited |
| Level 3: hardware-backed authenticators | Partial | admins: single-device security keys only (synced passkeys refused, optional attestation allow-list); users may use any passkey or password + TOTP — L3 for end users is not claimed |

## V7 Session management — target Level 3

| Area | Status | Evidence |
|---|---|---|
| Session tokens | Met | 256-bit random tokens, only their SHA-256 stored (`modules/auth/sessions.ts`) |
| Lifetime | Met | users 30 days idle / 90 days absolute; admins 30 min / 8 h (config validation enforces the admin maxima) |
| Rotation and revocation | Met | new session on login, step-up and privilege change; sign-out everywhere; password change and reset revoke other sessions; realtime sockets of revoked sessions are closed |
| Re-authentication for sensitive actions | Met | `stepUp` routes (route matrix); admin step-up within 5 min with the security key |

## V8 Authorization

| Area | Status | Evidence |
|---|---|---|
| Deny by default | Met | every route must name a policy, rate limit and audit decision (types); the route matrix lists them and its test fails on unreviewed unauthenticated or capability-free admin routes |
| Object-level (IDOR) | Met | membership/ownership checks per ID; non-members get the same 404 as for a missing object (integration suites per module) |
| Admin plane | Met | RBAC capabilities checked before the body is parsed, four-eyes for privilege changes, purpose binding for account views, no impersonation route; every call audited (admin.md) |

## V9 Self-contained tokens

| Area | Status | Evidence |
|---|---|---|
| JWT and similar | Partial | the API issues none for users or admins (opaque sessions). LiveKit join tokens (short-lived, room- and identity-scoped) and the OIDC ID token from the admin identity provider (verified by `openid-client`) are the only ones |

## V10 OAuth and OIDC

| Area | Status | Evidence |
|---|---|---|
| Admin sign-in as an OIDC client | Met | authorization code + PKCE, state, nonce through the certified `openid-client` (which verifies issuer, audience and signature), flow cookie, email-domain allow-list, subject binding (`modules/admin/oidc.ts`, admin E2E against a test identity provider) |
| Acting as an authorization server | N/A | none |

## V11 Cryptography — target Level 3

| Area | Status | Evidence |
|---|---|---|
| No custom cryptography | Met | OpenMLS for messaging; RustCrypto / libsodium-family primitives; HPKE (RFC 9180), SFrame (RFC 9605) — crypto-design.md; reviewed against its own rule in review.md |
| Randomness | Met | CSPRNG only; `Math.random` is a lint error everywhere (including test tooling) |
| Key management | Partial | key hierarchy documented (crypto-design.md, security.md §9); secrets in Secrets Manager under per-environment KMS keys (infra/terraform), rotation runbook (ops/runbooks/secrets.md); automated rotation and KMS envelope wrapping of the pepper are not built; release signing key runbook exists |
| Algorithms and agility | Partial | ciphersuite negotiated per group; post-quantum plan (X-Wing) awaiting S-02 |
| Independent review | Gap until S-13 | external crypto audit (audit-brief.md §2) |

## V12 Secure communication

| Area | Status | Evidence |
|---|---|---|
| TLS to clients | Partial | configured in code (CloudFront TLSv1.2_2021, load balancers ELBSecurityPolicy-TLS13-1-2-2021-06, HSTS); verified only once staging exists |
| Internal TLS | Partial | `sslmode=verify-full` and `rediss://` enforced by production config validation (and by the rendered manifests' config test); in-cluster HTTP between pods (API → fetcher, load balancer → pods) is plain inside the VPC — a service mesh with mTLS is not built |

## V13 Configuration

| Area | Status | Evidence |
|---|---|---|
| Secure defaults, validated configuration | Met | every service validates its configuration at boot; production refuses test settings (payment test keys, insecure OIDC, missing franking/moderation keys, missing breached-password mirror) |
| Secrets | Met | none in the repository (gitleaks in CI, history scanned); `.env.example` only |
| Dependencies and build | Partial | lockfiles, OSV (npm and Cargo, F-02), dependency review, CodeQL, pinned actions, `cargo deny`; release pipeline with SBOMs, Trivy gate, cosign signatures verified at deploy, BuildKit provenance (F-06, Phase 17); **admission policy and SLSA L3 not built; the pipeline has not run yet** |
| Unnecessary features | Met | no debug endpoints in production; health endpoints on a separate port |

## V14 Data protection

| Area | Status | Evidence |
|---|---|---|
| Sensitive data in transit and at rest | Met | message and media content end-to-end encrypted; the server stores ciphertext only (schema: `ciphertext bytea`) |
| Data minimisation and retention | Met | 30-day mailbox, retention settings per data class, metadata inventory (privacy.md §4) |
| Caching | Met | `Cache-Control: no-store` on authenticated API responses; the service worker never caches API, realtime or media |

## V15 Secure coding and architecture

| Area | Status | Evidence |
|---|---|---|
| Architecture boundaries | Met | `apps/*` may not import `services/*`; client crypto only in `packages/crypto-core`; table ownership per module (architecture tests) |
| Dangerous functionality isolated | Met | the link-preview fetcher (DNS pinning, address deny-list, limits) runs as its own deployment with no data stores or keys and public-443-only egress; its answers are validated as untrusted (F-05, Phase 17; `fetcher-app.test.ts`, `policy.test.ts`) |
| Memory safety, concurrency | Met | TypeScript and Rust (no `unsafe` blocks in our crate's source); per-conversation serialisation; idempotent workers |

## V16 Security logging and error handling

| Area | Status | Evidence |
|---|---|---|
| Logging | Met | structured logs with a field allow-list — no content, tokens, keys, emails or addresses (`packages/platform/src/logger.ts`) |
| Audit trail | Met | hash-chained `audit_log`; every admin call audited before the response; moderation decisions and evidence views audited |
| Error handling | Met | RFC 9457 problem details with stable codes, no stack traces or internals; unexpected errors logged with an error ID; background jobs survive database outages (Phase 15 fix) |

## V17 WebRTC

| Area | Status | Evidence |
|---|---|---|
| Media encryption and peer authentication | Met | 1:1 DTLS fingerprints carried inside MLS (substitution refused — E2E); group calls SFrame keyed from the MLS exporter, SFU sees ciphertext only (E2E) |
| TURN | Met | short-lived HMAC credentials, peer address deny-list verified against real coturn (integration test) |
| SFU | Met | LiveKit tokens per room and identity; unsupported browsers refused, never downgraded |

## Summary

No chapter has an unaddressed gap that the exit criterion counts as critical or high. The
partial areas are the items listed as open medium findings in review.md (F-05, F-06, F-09) and
the properties that only a deployed environment or the external assessments can show (TLS,
key custody, independent crypto review).
