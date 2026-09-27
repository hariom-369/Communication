# Admin architecture

Status: PROPOSED · Related: [moderation.md](moderation.md), [security.md](security.md)

## 1. Isolation

- Separate SPA (`apps/admin`) on a separate origin (`admin.<internal-domain>`), separate API
  prefix (`/admin/v1`) served by admin-only pods of `services/api` with a separate ingress.
- Access only via ZTNA (identity-aware proxy) — not reachable from the public Internet.
- Staff authenticate via corporate IdP (OIDC) with **hardware-backed WebAuthn required**;
  no shared credentials; no local admin passwords.
- Sessions: 8 h absolute, 30 min idle; re-auth for sensitive actions.

## 2. Roles (RBAC)

| Capability | Super Admin | Security Admin | Moderator | Support Agent | Billing Admin | Analyst |
|---|---|---|---|---|---|---|
| Dashboard (aggregates) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| View user account metadata | ✓ | ✓ | case-scoped | ticket-scoped | billing-scoped | — |
| Restrict/suspend/ban | ✓ | ✓ | ✓ (ban needs 2nd reviewer) | — | — | — |
| Moderation queue / evidence | ✓ | view | ✓ | — | — | — |
| Groups/communities/channels admin actions | ✓ | ✓ | ✓ | — | — | — |
| Security events, sessions revoke | ✓ | ✓ | — | revoke on user request | — | — |
| System/DB/queue/storage health | ✓ | ✓ | — | — | — | ✓ (read) |
| Subscriptions, refunds | ✓ | — | — | view | ✓ | — |
| Analytics (aggregated, k-anonymous) | ✓ | — | — | — | view | ✓ |
| Feature flags | ✓ (4-eyes) | ✓ (security flags) | — | — | — | — |
| Audit log | ✓ | ✓ | own actions | own actions | own actions | — |
| Manage admin roles | ✓ (4-eyes) | — | — | — | — | — |

- Grants are time-bound; elevated roles (Super/Security Admin) are **just-in-time**:
  requested, approved by a second admin, auto-expire (≤ 8 h).
- Every data view is scoped to a case/ticket ID ("purpose binding"); browsing without a
  case is not possible for Moderator/Support roles.
- Break-glass production DB access: separate procedure, two approvers, session recorded.

## 3. What admins can never do

Read E2EE content (technically impossible); log in as a user (no impersonation feature);
see password hashes, session tokens, TOTP secrets, recovery codes; bypass MFA on a user's
behalf; export bulk personal data without a Legal-approved request.

## 4. Features

Dashboard (DAU/MAU, messages/s, errors, queue depth); user management (search by exact
identifier, status, restrictions, devices list metadata, sessions); report and moderation
queues; group/community/channel management; security events (login anomalies, rate-limit
hot spots); system, DB, queue, storage, bandwidth health (embedded Grafana panels via
SSO); subscriptions & payments (refunds with reason); analytics; feature flags (with
audit + staged rollout); audit log viewer (hash-chain verification indicator);
support tools (resend verification, start recovery review — never bypass).

## 5. Audit

Every admin API call writes `audit_log` (actor, role, case/ticket, action, target,
before/after for state changes, request ID, IP). Alerts: bulk lookups, off-hours
elevated access, repeated evidence views, role changes.
