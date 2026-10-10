# Security architecture and controls

Status: PROPOSED · Verification standard: **OWASP ASVS 5.0** — Level 2 for all components,
Level 3 for authentication, session management, cryptography, admin. Threats:
[threat-model.md](threat-model.md). Crypto: [crypto-design.md](crypto-design.md).

## 1. Security principles

1. No fake security: every claim in UI/marketing maps to a mechanism in these docs.
2. Defence in depth: each boundary validated independently (client, edge, API, DB).
3. Least privilege: per-service DB roles, per-pod IAM roles, admin RBAC with JIT elevation.
4. Secure defaults: deny-by-default authorization; new routes fail CI without explicit policy.
5. Everything auditable; nothing sensitive logged.

## 2. Transport

- TLS 1.3 preferred, 1.2 minimum with AEAD suites only, at CloudFront/ALB/NLB; HTTP → HTTPS
  redirect only on the apex marketing site; API and app origins are HTTPS-only.
- HSTS: `max-age=63072000; includeSubDomains; preload` (after staging validation).
- Internal traffic: mTLS (service mesh) or TLS to managed services (RDS, ElastiCache with
  in-transit encryption).

## 3. HTTP security headers (app and API origins)

```
Content-Security-Policy:
  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' blob: data: https://media.<domain>; media-src 'self' blob: https://media.<domain>;
  connect-src 'self' https://api.<domain> wss://rt.<domain> https://<s3-upload-host>;
  worker-src 'self' blob:; manifest-src 'self'; font-src 'self';
  frame-src https://view.<usercontent-domain>; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'; require-trusted-types-for 'script'; trusted-types tessera-default;
  upgrade-insecure-requests; report-to csp
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp        (evaluate: needed for SharedArrayBuffer only)
Cross-Origin-Resource-Policy: same-site
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=(self),
                    payment=(), usb=(), interest-cohort=()
X-Frame-Options: DENY                               (legacy)
Cache-Control: no-store                            (all authenticated API responses)
```

Web app, as implemented (Phase 4, `apps/web/vite.config.ts`): `script-src 'self'
'wasm-unsafe-eval'` (WebAssembly compilation for the crypto worker; no `unsafe-eval`),
`worker-src 'self'`, `connect-src 'self'` (API and realtime share the origin, ADR-033), and
Trusted Types with exactly one policy, `tessera-worker`, which only produces same-origin script
URLs for the crypto worker (Phase 9: also the call-media worker; Phase 10: the service worker
`/sw.js`, registered with `updateViaCache: 'none'` so a fix to it reaches browsers at once).
Phase 14: the service worker also pins the app shell (ADR-052): it answers page loads and the
release's own files from a copy verified against the signed release manifest, and leaves every
other request (API, realtime, SFU, media) to the network untouched. `manifest-src 'self'` serves
the web app manifest; SRI covers the scripts and stylesheet `index.html` loads.

Phase 6 additions: `img-src 'self' data: blob:` and `media-src 'self' blob:` (decrypted
attachments are shown from `blob:` URLs created in the app; previews are `data:` JPEGs from inside
the encrypted message), `connect-src` gains the object-storage origin (`TESSERA_MEDIA_ORIGIN`) for
presigned uploads and downloads, and `Permissions-Policy: microphone=(self)` for voice messages.
Decrypted attachments are only rendered inline for an allow-list of image/video/audio types; any
other type (including HTML and SVG) is offered as a download with `application/octet-stream`, so a
crafted attachment can never become a same-origin document (ADR-043).

## 4. Input validation and output encoding

- All inputs validated with Zod at the edge of the API (strict objects — unknown keys
  rejected; string lengths; numeric ranges; enum allow-lists; UUID formats).
- JSON body parser: size limit per route; reject duplicate keys; `__proto__`/`constructor`
  keys rejected (Fastify `onProtoPoisoning: 'error'`, `onConstructorPoisoning: 'error'`)
  → prototype pollution defence. Objects created from input use `Object.create(null)` maps
  where dynamic keys are needed.
- SQL: Kysely parameterised queries only; raw SQL only via tagged template `sql` with
  bound parameters; lint rule bans string-concatenated SQL.
- No shell execution from request paths. Media workers invoke ffmpeg with argument arrays
  (no shell), fixed binary paths, inputs as files with generated names (path traversal
  and command injection impossible by construction).
- Paths: object keys and file names are server-generated UUIDs; user-supplied filenames
  live only in E2EE payloads or are sanitised for `Content-Disposition` (RFC 6266 encoding).
- Output: React escapes by default; `dangerouslySetInnerHTML` banned by lint; rich text is
  rendered from a parsed AST (our own markdown subset) into React elements — never HTML
  strings. Link rendering: only `https:`/`mailto:` schemes; `rel="noopener noreferrer"`;
  punycode displayed for IDNs.

## 5. Authorization

- Central policy functions per resource (`canSendToConversation(actor, conv)` etc.),
  called by route definitions; object-level checks on every ID in a request (IDOR defence).
- Authorization tests generated from a permission matrix per module ([testing.md](testing.md)).

## 6. SSRF protection

Two components send requests to user-supplied URLs: the **link-preview fetcher** (channels/public
content; E2EE link previews are generated by the *sending client*, not the server) and **Web Push
delivery** (Phase 10, ADR-048), which POSTs only to `https:443` endpoints on an allow-list of push
services (`PUSH_SERVICE_HOSTS`), through the same DNS pinning and address deny-list, without
following redirects (`platform/safe-fetch/post.ts`, mutation-tested).

**Status (Phase 8, ADR-046):** implemented as `services/api/src/platform/safe-fetch` with every
rule below and an SSRF test suite; it currently runs **inside the API process**. Moving it into an
isolated service with its own egress proxy is required before the first shared environment.

Fetcher runs as an isolated service with egress through a proxy that: resolves DNS itself
and blocks private, loopback, link-local, CGNAT, multicast and cloud-metadata ranges (IPv4
and IPv6, including IPv4-mapped IPv6); re-validates after redirects (max 3); allows only
`https` on 443; 5 s timeout; 2 MiB response cap; parses only HTML `<head>` metadata; no
cookies; fixed User-Agent. Same deny-list on TURN relays — **implemented in Phase 9** as
`infra/calls/turnserver.conf` (`denied-peer-ip`), verified against real coturn by
`turn-relay.integration.test.ts`; deployments add their own VPC and public service ranges.

## 7. Rate limiting and abuse throttling

GCRA token buckets in Valkey keyed by combinations of IP (/64 for IPv6), account, device,
route, and target (e.g. per-recipient message limits). Edge WAF rate rules as an outer
layer. Limits fail closed for auth; details in [moderation.md §4](moderation.md).

**Shared addresses (implemented in Phase 2).** Carrier-grade NAT is common on Indian mobile
networks, so thousands of legitimate users can share one IPv4 address. Therefore:
- every request first passes a generous per-IP flood guard (default 1,200/min, burst a quarter of that; `IP_FLOOD_LIMIT_PER_MINUTE`);
- route limits on **authenticated** routes are keyed per user, not per IP;
- public routes (sign-up, login, reset) combine a CGNAT-tolerant per-IP limit with strict
  per-identifier limits (per email / username), which are the real brute-force control;
- risk-based challenges (CAPTCHA-style) for abusive sources are deferred (Phase 12/15; not
  built in Phase 11).

**Abuse controls (implemented in Phase 11, [moderation.md](moderation.md) §0).** New-account
limits (first 7 days), per-person report limits (closed on store failure), a per-address limit
on the public grievance form, automated new-chat restriction on behaviour signals, a suspension
gate on every signed-in route (`whileSuspended` routes excepted: status, appeals, sessions,
sign-out), and server-enforced blocks.
A regression test ("many people behind one shared IP") guards this behaviour.

## 8. Error handling

RFC 9457 `application/problem+json` with stable `type` codes and user-safe `detail`. No stack
traces, SQL errors, internal hostnames, or library versions. Internal error IDs link to
logs. `Server`/`X-Powered-By` headers removed.

## 9. Secrets and keys

| Secret | Storage | Rotation |
|---|---|---|
| DB/Valkey credentials | Secrets Manager (+ IAM auth for RDS where possible) | 30 days automated |
| Password pepper, TOTP KEK, cursor HMAC key | KMS (envelope) | yearly, versioned |
| VAPID keys, TURN shared secret, LiveKit API key | Secrets Manager | 90 days (TURN: 24 h overlap) |
| Franking key ring (`FRANKING_KEYS`) | KMS (envelope) | yearly, versioned (old ids keep verifying) |
| Moderation HPKE key pair (`MODERATION_HPKE_*`) | KMS-held private key | on staff change / yearly; old evidence needs the old key until it expires |
| Payment provider keys, webhook secrets | Secrets Manager | on staff change / yearly |
| Release signing key | Sigstore keyless (OIDC) + HSM-backed key for manifest | per policy |

Secret scanning: gitleaks pre-commit + CI; GitHub push protection.

## 10. Supply chain

- **Web releases** are signed (ADR-052): `RELEASE_SIGNING_KEY` (Ed25519, PKCS#8) exists only in
  the release pipeline's secret store; production builds set `RELEASE_REQUIRE_OFFICIAL=1` so an
  unsigned build cannot ship; the successor key is announced in the previous release
  (`RELEASE_NEXT_KEYS`). Losing the key without an announced successor strands browsers on the
  last release until their site data is cleared — custody and rotation runbook in Phase 15.

- Lockfiles committed; `pnpm install --frozen-lockfile`; `cargo --locked`.
- Dependency review on PRs; OSV-Scanner + `cargo audit`/`cargo deny` (licenses, advisories,
  bans); Renovate with grouped, reviewed updates; new dependency requires justification in PR.
- No install scripts by default (`pnpm` `onlyBuiltDependencies` allow-list).
- SBOM (CycloneDX) per build; container images from minimal bases (distroless), scanned
  (Trivy), signed (cosign), admission policy verifies signatures in the cluster.
- SLSA Build L3 target: GitHub Actions with OIDC, isolated builders, provenance attestations.
- CI actions pinned by commit SHA; least-privilege `GITHUB_TOKEN` permissions.

## 11. Audit logging

Append-only `audit_log`, hash-chained (each row includes hash of previous), exported
hourly to write-once storage (S3 Object Lock, compliance mode). Covers: auth events,
session/device changes, admin actions, moderation decisions, data exports/deletions,
permission changes, key-publication events, billing state changes.

Moderation (Phase 11) records every staff decision (`moderation.<action>`, approvals,
reversals, appeal outcomes, dismissals, legal orders, blocklist and hash-list changes), every
evidence view (`moderation.evidence_viewed`) and staff-role grants and revocations; each case
also keeps its own append-only timeline. The integration suite checks that each of these is
present and that the chain verifies.

The admin console (Phase 12, ADR-050) audits **every** call by construction: the admin request
pipeline writes the entry (action = route id; actor, roles, client address, outcome, target,
purpose) before the response is sent and fails the call if it cannot; refusals are audited by an
error hook. The integration suite calls every admin route as every role and without a session and
checks one entry per request.

**Admin plane (Phase 12, [admin.md](admin.md)).** Separate process, origin, CORS/CSRF allow-list
and cookie (`__Host-tadm`, SameSite=Strict); corporate OIDC (PKCE, state, nonce) then a
single-device security key (synced passkeys refused; optional model allow-list via vendor
attestation); 8 h / 30 min sessions; step-up within 5 min for sensitive actions; capabilities
checked before the body is parsed; four eyes for role, eligibility, admin, flag and staff-role
changes; purpose binding for every account view; no impersonation route. The admin SPA's CSP
forbids WebAssembly, workers, blob:/data: and any Trusted Types policy.

**Billing (Phase 13, [billing.md](billing.md)).** Hosted checkout only (no card or UPI data;
SAQ-A). Webhooks use the pipeline's `webhook` auth kind — no cookie, no browser CSRF check, raw
body — and are accepted only with a valid provider signature (HMAC-SHA256, constant time; Stripe
timestamp ≤ 5 min; Razorpay event id), applied once per event id, and from the provider's current
state under a lock. Provider API URLs other than the official ones and test-mode keys are refused
in production. Payment state changes are audited (`billing.status_changed`, `billing.cancelled`,
`billing.checkout_started`).

## 12. Browser storage policy

| Data | Storage |
|---|---|
| Session | HttpOnly cookie only |
| Crypto state, message cache, media cache | IndexedDB/OPFS, encrypted by crypto worker |
| UI prefs (theme) | localStorage (non-sensitive only) |
| Nothing | sessionStorage/localStorage for tokens, keys, messages, PII |

## 13. Specialist review required

S-01..S-12 in [review-register.md](review-register.md); plus third-party penetration test
before public beta and annually; bug bounty after GA.
