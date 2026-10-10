# Admin architecture

Status: IMPLEMENTED (Phase 12, ADR-050) · Related: [moderation.md](moderation.md),
[security.md](security.md), [decisions.md](decisions.md) ADR-050

## 0. As built (Phase 12)

| Part | Where |
|---|---|
| Admin API process (`/admin/v1/*` only) | `services/api/src/admin-server.ts`, `admin-app.ts`, `admin-compose.ts` |
| Request pipeline (capability, step-up, audit of every call) | `services/api/src/platform/http/admin-routes.ts` |
| Sign-in (OIDC, security keys), sessions, roles, approvals, purpose binding | `services/api/src/modules/admin/` |
| Feature flags | `services/api/src/modules/flags/` |
| Break-glass operator command | `services/api/src/cli/admin.ts` (`pnpm --filter @tessera/api admin …`) |
| Admin console (SPA, own origin, strict CSP) | `apps/admin` |
| Schemas | `packages/validation/src/admin.ts` · migration `0013_admin.sql` |

Tests: `modules/admin/admin-auth.integration.test.ts` (identity provider, keys, sessions,
separation from the user API, operator command), `modules/admin/admin.integration.test.ts`
(**authorization matrix**: every route × every role; **audit completeness**: every call
including refusals; purpose binding; four eyes and just-in-time elevation; flags; aggregates;
audit viewer), `apps/admin/e2e/admin.spec.ts` (the console end to end with a test identity
provider and virtual security keys, CSP, accessibility). 18 mutation checks of the security logic
are recorded in [phase-reports/phase-12.md](phase-reports/phase-12.md).

## 1. Isolation and sign-in

- Separate SPA (`apps/admin`) on a separate origin (`admin.<internal-domain>`), separate API
  process serving only `/admin/v1` on its own port, with its own origin allow-list, CORS, CSRF
  check and session cookie (`__Host-tadm`, HttpOnly, Secure, SameSite=Strict). The user API
  serves no admin route and does not accept the admin cookie, and vice versa (tested).
- Access only via ZTNA (identity-aware proxy) — not reachable from the public Internet
  (deployment control, Phase 15).
- Staff are their own identities, not Tessera user accounts. They sign in with the corporate
  identity provider (OpenID Connect authorization code with PKCE S256, `state`, `nonce`; verified
  email on an allowed domain; the provider's issuer and subject are bound at first sign-in), then
  with a **hardware security key** (WebAuthn, user verification required). Synced passkeys are
  refused (backup flags). With `ADMIN_AUTHENTICATOR_AAGUIDS` set, only listed key models are
  accepted, proven by a `packed` attestation chaining to a vendor root in
  `ADMIN_ATTESTATION_ROOTS_FILE`. No shared credentials, no admin passwords.
- Sessions: 8 h absolute, 30 min idle; the token is replaced when the key step completes; roles
  are re-read on every request. Re-confirmation with the key (within 5 min) for: signing a person
  out, approving a request, disabling an admin, removing a staff role.

## 2. Roles (RBAC)

Every admin route names one capability (`services/api/src/modules/admin/rbac.ts`); what is not
listed is denied. This table is the authorization matrix the integration test checks route by
route.

| Capability (routes) | Super | Security | Moderator | Support | Analyst |
|---|---|---|---|---|---|
| Dashboard (aggregates) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Find a person, view account metadata — with a purpose | ✓ | ✓ | case-scoped | ticket-scoped | — |
| Sign a person out (one or all sessions) | ✓ | ✓ | — | ticket-scoped | — |
| Resend verification email | ✓ | — | — | ticket-scoped | — |
| Support tickets (open, list, close) | ✓ | — | — | ✓ | — |
| Failed sign-in hotspots | ✓ | ✓ | — | — | — |
| Health (database, cache, storage, queue) | ✓ | ✓ | — | — | ✓ |
| Analytics (sign-ups per day, counts < 5 suppressed) | ✓ | — | — | — | ✓ |
| Feature flags (view; changes by four eyes) | ✓ | ✓ (security flags) | — | — | — |
| Request changes; approve per kind (below) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audit log | all | all | own actions | own actions | own actions |
| Admins (view, disable at once) | ✓ | ✓ | — | — | — |
| Moderation staff roles (view, remove at once) | ✓ | ✓ | — | — | — |

Who may request / approve each four-eyes change (`approvals.ts`):

| Change | Request | Approve (never the requester; never the person a role is for) |
|---|---|---|
| Role grant | super admin; or an eligible admin for themselves (JIT, elevated roles) | super admin; security admin too for `security_admin` grants |
| Eligibility for JIT elevation | super admin | super admin |
| New admin | super admin | super admin |
| Feature flag | security flags: super or security admin; product flags: super admin | same |
| Moderation staff role on a user account | super admin | super or security admin |

- Grants are time-bound: elevated roles (Super/Security Admin) at most **8 h**, others at most 90
  days. Elevated roles are **just-in-time**: requested, approved by a second admin, auto-expire.
- Requests expire after 24 h; the database refuses self-approval; approval is claimed
  atomically (two simultaneous approvals: one wins).
- Every data view is scoped to a ticket, a case, or (security staff) a recorded investigation
  reason ("purpose binding"). A purpose that does not fit both the viewer and the person answers
  "not found". Browsing is not possible: lookups are by exact email, username or id only.
- Break-glass: the operator command creates admins and grants roles when no second admin can
  approve (bootstrap); it requires `--by <operator>`, keeps the 8-hour cap, and is audited.
  Production database access is a separate procedure (two approvers, session recorded —
  docs/disaster-recovery.md).
- Moderation itself happens in the in-app moderation console by user accounts holding staff
  roles (ADR-049); the admin console grants and removes those roles. *Deviation recorded in
  ADR-050.*

## 3. What admins can never do

Read E2EE content (technically impossible: the server has none); log in as a user (there is no
impersonation route); see password hashes, session tokens, TOTP secrets, recovery codes (the
account view shows counts and flags only); bypass MFA on a user's behalf; export bulk personal
data (no export route; lookups are one exact identifier at a time and bulk lookups alert).

## 4. Features (as built)

Dashboard (accounts, new and active in 24 h, messages in 24 h, open moderation cases and missed
deadlines, pending approvals, notification queue); people (exact lookup with a purpose; status,
standing, sign-in methods, devices, sessions, recent sign-ins; sign out one session or all;
resend verification); support tickets; approvals; admins (roles, eligibility, keys; disable);
moderation staff roles; feature flags (kill switches and staged rollouts, by four eyes);
security (failed sign-ins by network prefix); health; audit log viewer (filters, paging,
hash-chain verification indicator).

Not built: billing and refunds (no payments exist); group/community/channel admin actions
(handled by moderation cases); embedded Grafana panels (Phase 16).

## 5. Audit

Every admin API call writes `audit_log` **before the response is sent** — if the write fails the
call fails. Refusals (not signed in, forbidden, step-up needed, invalid input, rate-limited) are
audited too. Each entry has the actor, the action (the route id, e.g. `admin.user_detail`), the
target, the request id and details: outcome, the actor's roles at the time, client address,
purpose and route-specific fields. The log is hash-chained (ADR-026); the viewer shows whether
the chain verifies. Operator-command uses are audited as `system` with the operator's name.

Alerts (logged as `admin.alert`): bulk lookups (more than 20 in 10 minutes), role grants,
eligibility changes, admins disabled. Off-hours elevated access and repeated evidence views
become alerting rules with the observability stack (Phase 16).
