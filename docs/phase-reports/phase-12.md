# Phase 12 report — Admin console

**Status: GREEN locally, with one intermittent user-app E2E failure not reproduced (open items); pending the admin-plane security review (S-14).** Verified 2026-10-10.
CI has not run, because the branch still cannot be pushed (GitHub returns 403 for the Claude app).

Tessera staff now have their own console on a separate origin, served by a separate process.
They sign in with the company identity provider and then a hardware security key. Roles are
time-bound; elevated roles are granted just in time, and only when a second admin approves.
Sensitive changes need four eyes. A person's account can be seen only for a ticket, a case or a
recorded investigation, and only as metadata. Every call to the admin API — allowed or refused —
is in the audit log before the answer leaves the server. Design and trade-offs: **ADR-050** and
[admin.md](../admin.md) §0.

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass (new workspace `apps/admin`) |
| Unit tests | **605 TypeScript** (api 379, web 136, ui 59, platform 15, shared 7, realtime 3, validation 3, admin 3) + **75 Rust** (crypto core unchanged) |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **219 passed** (api 202, of which **46 admin**; realtime 17); 2 skipped (IPv6 TURN test without IPv6 here; opt-in channel scale test) |
| End-to-end, user app (Chromium, production build, strict CSP + Trusted Types, real services) | **44 passed in runs 2 and 3**; run 1: 43 passed, **1 failed** — the two-step verification test (`auth.spec.ts`), while a CPU-heavy 870 MB secret scan ran alongside; it passed 8 of 8 repeats in isolation afterwards. The cause is not established (the run's artifacts were overwritten by the next run), so it is listed under open items rather than written off; 1 skipped (opt-in call load test) |
| End-to-end, admin console (Chromium, production build, admin CSP, test identity provider, virtual security keys) | **6 passed in each of 3 consecutive runs** |
| Mutation checks | **18 of 18** seeded faults caught (below) |
| Accessibility (axe) | no violations on the sign-in page and all ten console pages |
| OpenAPI (user API) | 171 paths, 202 operations (1 new: `GET /api/v1/features`); the admin API is not in the public document by design |
| `pnpm audit --prod` / gitleaks | no known vulnerabilities / no leaks (history and every file to be committed) |

### Exit criteria

| Criterion | Evidence |
|---|---|
| **Admin authorization matrix** | `admin.integration.test.ts`: the role table of admin.md §2 is written out in the test; every one of the 28 signed-in admin routes (30 in all, with the two identity-provider steps) is called as each of the 5 roles and must be refused (403 FORBIDDEN) exactly where the table says; a second test calls every route without a session (401); a third asserts the table covers every registered admin route, so a new route cannot ship without a row. Authorization runs before the body is parsed, so a refused role learns nothing about a route's input |
| **Audit completeness** | the same matrix run (140 calls) and the anonymous run (28 calls) each find exactly one audit entry per request id, with the right action, actor (or none), roles, address and outcome — including refusals and invalid requests; a call whose audit write fails returns 500 and no data ("no audit, no answer") |

## Delivered

- **Admin API process** (`admin-server.ts`, `admin-app.ts`, `admin-compose.ts`): only
  `/admin/v1`, own port (8082; health 9092), origins, CORS/CSRF, cookie (`__Host-tadm`,
  SameSite=Strict); same hardening as the user API (security headers, problem+json, no client
  request ids). Admin limits fail closed when the rate-limit store is down.
- **Pipeline** (`platform/http/admin-routes.ts`): caller identified first, then stage, rate
  limit, capability and step-up checks before validation; audit entry written before the
  response; refusals audited from the error hook.
- **Sign-in** (`modules/admin/oidc.ts`, `keys.ts`, `auth.ts`, `sessions.ts`): OIDC code flow
  with PKCE, state and nonce via `openid-client`; verified email on an allowed domain; issuer and
  subject bound at first sign-in. Security keys via `@simplewebauthn/server`: UV required,
  single-device only, at most five; optional model allow-list proven by a `packed` attestation
  chaining to configured vendor roots and naming the model (AAGUID extension). Session token
  replaced after the key step; 8 h absolute, 30 min idle; key step-up within 5 min.
- **RBAC, JIT, four eyes, purpose binding** (`rbac.ts`, `admins.ts`, `approvals.ts`,
  `service.ts`): 5 roles; elevated grants ≤ 8 h; requests for role grants, eligibility, new
  admins, flag changes and moderation staff roles; purposes `ticket:`, `case:`,
  `investigation:`; account metadata only; session revoke; verification resend; support
  tickets; dashboard; sign-ups with small counts suppressed; failed-sign-in hotspots; health of
  database, cache, object storage and notification queue; admins and staff-role lists; audit
  viewer (all + chain check for security staff, own actions otherwise). Alerts for bulk lookups,
  role grants, eligibility changes and disabled admins.
- **Feature flags** (`modules/flags`, migration seeds): stable rollout buckets, 15 s cache,
  unknown flags on; `link_previews` switches the preview fetcher off, `group_calls` the group-call
  capability; `GET /api/v1/features` for clients.
- **Operator command** (`cli/admin.ts`): create, grant (8-hour cap kept), eligibility, disable,
  list; requires `--by`; audited as `system`.
- **Admin console** (`apps/admin`): sign-in (identity provider redirect, callback that clears the
  code from the address bar, key registration or use); navigation by capability; dashboard;
  people (exact lookup with a purpose; account view; sign out one or all sessions with key
  step-up; resend verification); tickets; approvals (approve with step-up, reject with a note,
  withdraw your own); admins (roles, eligibility, keys; four-eyes forms; disable); staff roles;
  feature flags; security hotspots; health; audit log (filters, paging, chain status); request
  elevation. CSP: `script-src 'self'`, no WebAssembly, no workers, no blob:/data:,
  `trusted-types 'none'`; `no-store`; robots `noindex`.
- **Schemas** `packages/validation/src/admin.ts`; migration `0013_admin.sql` (admin users, keys,
  sessions, role grants, approvals with a self-approval CHECK, support tickets, feature flags).
- **Test tools:** a test identity provider (`src/test/fake-idp.ts`: discovery, PKCE, client
  authentication, ES256 ID tokens, a sign-in page for browsers, and a `misbehave` switch for wrong
  nonce/audience/issuer/expired tokens), run as a process for E2E (`scripts/fake-idp.mjs`); test
  security-key vendors with real X.509 attestation chains (`src/test/attestation.ts`); the
  software authenticator gained single-device keys and `packed` attestation (vendor or self).

## Tests added

- `admin-auth.integration.test.ts` (20): PKCE/state/nonce in the authorization URL and the flow
  cookie; subject binding and impostor refusal; unknown person, unverified email, other domain,
  disabled admin (each refusal audited); wrong nonce, audience, issuer, expired token; changed
  state, replayed flow, missing flow cookie; first sign-in registers a key, half-signed-in
  session has no access, token replaced, only the registered key works; synced passkey, no user
  verification, key answer for another origin; key flow bound to its session; model allow-list
  (listed model with vendor chain accepted; no attestation, self attestation, unlisted model,
  untrusted vendor, certificate without the model extension refused); idle and absolute expiry;
  roles expiring and admin disabled mid-session; sign-out; step-up after 5 min (and another
  admin's key does not count); separation from the user API (routes, cookies both ways, origin,
  preflight); security headers; operator command.
- `admin.integration.test.ts` (26): the matrix and audit-completeness tests above; purpose
  binding for support, moderators and security staff (wrong person, closed ticket, resolved case,
  short reason, analysts never); metadata only; sign a person out; resend refused when verified;
  bulk-lookup alert; JIT elevation (not eligible, over 8 h, other role, for someone else; self and
  subject cannot approve; approval grants with the approval id; alert); database refuses
  self-approval; the subject of a grant cannot approve it even as super admin; simultaneous
  approvals; expiry, withdraw, reject; step-up for approving; new admin and staff role only after
  approval; staff role removal; failed change returns to pending; disabling an admin; flag
  permissions by kind; kill switches reach `/api/v1/features` and the calls capability; stable,
  monotone rollouts; k-anonymous sign-ups; dashboard has no personal data; health; hotspots;
  audit viewer own-only and chain check; no secrets in the audit view.
- `config.test.ts` (+3): admin defaults, session caps, OIDC all-or-nothing, allow-list needs
  roots, https and no insecure switch in production.
- `apps/admin/e2e/admin.spec.ts` (6): first sign-in with key registration under the admin CSP,
  support-only navigation, HttpOnly strict cookie, ticket → purpose-bound lookup (wrong person
  "not found") → sign-out everywhere → own audit trail, sign-out ends the server session; synced
  passkey refused; four-eyes flag change across two admins' browsers; JIT elevation approved by
  another admin; audit chain and health; axe on every page.

### Mutation checks (18/18 caught)

Analyst added to tickets · synced-passkey check removed · self attestation accepted under the
allow-list · model extension not required · investigation open to every role · closed or
foreign ticket accepted · requester may approve · subject of a grant may approve · approval not
claimed atomically · JIT for someone else · refusals not audited · step-up not enforced · idle
limit removed · token not replaced on activation · subject binding removed · email domain not
checked · small sign-up counts shown · audit viewer not limited to own actions.

The first run left three faults uncaught (self attestation, a grant's subject approving, and
k-anonymity, whose test depended on the day's sign-up count); the tests were strengthened until
all 18 were caught.

## Problems found and fixed during the phase

- **Self-attested security keys could claim any model** under the allow-list (the library accepts
  `packed` self attestation, and skips chain validation without trust anchors). The allow-list now
  requires an attestation certificate chain to configured vendor roots that names the model;
  configuring an allow-list without roots is refused at start-up.
- **Refusals from the wrong sign-in stage were audited without the actor**; the caller is now
  identified before any refusal.
- **Authorization ran after body validation** (a refused role could learn a route's input shape
  from 400s); capability and step-up checks now run before parsing.
- The admin process's default port collided with the realtime service (8081/9091): now
  8082/9092.
- The sign-in steps' per-address limit (burst 10) would lock out an office behind one NAT after
  five sign-ins; raised to 20 per 10 minutes — the identity provider authenticates, so these steps
  check no guessable secret.

## Security implications (threat-model delta)

Recorded in [threat-model.md](../threat-model.md) (Phase 12 delta), [security.md](../security.md)
(admin plane, audit) and [privacy.md](../privacy.md) (admin views, tickets, staff identities). In
short: the admin plane is a new trust boundary (TB6) with the highest privilege in the system.
Takeover needs the corporate identity and the physical key on the admin origin; one person cannot
grant themselves power or flip a flag; support staff cannot browse; every look is purpose-bound
and audited. Residual: two colluding super admins; metadata within role and purpose; the
single-device property is the authenticator's claim without an allow-list; vendor certificate
revocation (FIDO MDS) not consulted; off-hours and repeated-view alert rules wait for Phase 16;
reachability only through the access proxy is a deployment control (Phase 15). Staff audit
entries keep the full client address (accountability), unlike user records.

## Open items

- **Intermittent failure, user app E2E** (`auth.spec.ts` two-step verification): one failure in
  three full runs, under concurrent load; not reproduced in 8 isolated repeats. Next step: capture
  the trace when it recurs (CI keeps traces on failure) and fix the cause; suspected but unproven:
  5-second expectations after Argon2id sign-ins on a loaded machine. Phase 12 changed nothing in
  the sign-in or two-step paths.

## Moved / not done

- Billing and refund tools — no payments exist yet.
- Embedded Grafana panels, off-hours elevated-access and repeated-evidence-view alert rules →
  Phase 16 (observability).
- FIDO Metadata Service (vendor certificate revocation, model metadata) → with review S-14.
- Support-assisted account recovery review (moved here from Phase 2) → Phase 14, with the
  recovery UX work; the console can already sign a person out and resend verification.
- An OpenAPI document for the admin API (internal; the schemas live in `packages/validation`).

## Commit

Branch `claude/trusting-goodall-55613i`. Push still blocked (403) — the user needs to reconnect
GitHub with the Claude app installed (https://claude.ai/connect-github).
